#!/usr/bin/env node
/**
 * Builds the SAS language server from the upstream commit recorded in
 * provenance.json, and stages the two targets this package ships.
 *
 * Upstream publishes no built server: `dist` is gitignored and there are no
 * release assets, so the server is compiled here from source. That makes this
 * the one heavy step in the package, which is why it is skipped when the staged
 * server already matches the pinned commit.
 *
 *   server/browser/server.js   webworker build, for a browser editor
 *   server/node/server.js      node build, run over IPC by a VS Code extension
 *
 * The browser build is the large one. The node build of the same server is a
 * fraction of it, because the browser bundle inlines the Python stubs the node
 * build leaves on disk.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { UPSTREAM } from './groups.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(root, '.upstream', 'server')
const marker = join(work, '.built-from')
const stage = join(root, 'server')

const TARGETS = [
  { name: 'browser', from: 'server/dist/browser/server.js', to: 'browser/server.js' },
  { name: 'node', from: 'server/dist/node/server.js', to: 'node/server.js' }
]

/**
 * Licence texts the server's components require us to carry.
 *
 * The bundle's own server.js.LICENSE.txt covers only buffer (MIT) and ieee754
 * (BSD-3-Clause) - it does not mention pyright or typeshed, which are both
 * inside it. Apache-2.0 needs a copy of the licence to travel with the copy,
 * so each of these is staged next to the artifact.
 */
const LICENCES = [
  ['LICENSE', 'LICENSE.txt'], // the extension itself, Apache-2.0
  ['server/dist/node/typeshed-fallback/LICENSE', 'LICENSE.typeshed.txt'],
  ['server/dist/browser/server.js.LICENSE.txt', 'LICENSE.server.js.txt']
]

// pyright declares MIT in its package.json but ships no licence file, and MIT
// requires the notice to be included in every copy.
const PYRIGHT_LICENCE = `pyright-internal (pyright)
Copyright (c) Microsoft Corporation

Licensed under the MIT License:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

const run = (args, cwd) =>
  execFileSync(args[0], args.slice(1), { cwd, stdio: 'inherit', env: process.env })

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

const pinnedRef = () => {
  const provenance = JSON.parse(readFileSync(join(root, 'provenance.json'), 'utf8'))
  return provenance.upstreamRef
}

/**
 * Fetch the upstream repository at an exact commit. A shallow fetch of the
 * commit itself is enough: the server build reads only that tree, and fetching
 * a single commit avoids pulling the whole history for a 30 MB artifact.
 */
const prepareSource = (ref) => {
  const repo = `https://github.com/${UPSTREAM.owner}/${UPSTREAM.repo}.git`
  if (existsSync(join(work, '.git'))) {
    run(['git', 'fetch', '--depth', '1', 'origin', ref], work)
  } else {
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })
    run(['git', 'init', '--quiet'], work)
    run(['git', 'remote', 'add', 'origin', repo], work)
    run(['git', 'fetch', '--depth', '1', 'origin', ref], work)
  }
  run(['git', 'checkout', '--quiet', '--force', 'FETCH_HEAD'], work)
}

const build = (ref) => {
  prepareSource(ref)

  // The lockfile is committed upstream, so `npm ci` is both faster and the same
  // install the extension's own CI performs.
  //
  // Scripts are forced on for this install: the package's own .npmrc sets
  // ignore-scripts=true so a compromised dependency cannot run code at install
  // time, but the upstream build needs them - esbuild installs its platform
  // binary from a postinstall.
  run(['npm', 'ci', '--no-audit', '--no-fund', '--ignore-scripts=false'], work)

  // The node build first: it also copies the Python stubs into dist/node, which
  // the browser build's typeshed loader reads while bundling.
  run(['npm', 'run', 'compile'], work)
  run(['npm', 'run', 'compile-browser'], work)
}

const stageTargets = async () => {
  const staged = []
  for (const target of TARGETS) {
    const source = join(work, target.from)
    const destination = join(stage, target.to)
    if (!existsSync(source)) {
      throw new Error(`build produced no ${target.from}`)
    }
    mkdirSync(dirname(destination), { recursive: true })
    await copyFile(source, destination)
    staged.push({
      target: target.name,
      file: `server/${target.to}`,
      bytes: readFileSync(destination).length,
      sha256: sha256(destination)
    })
  }
  return staged
}

/**
 * Record what was built alongside the artifact, so the tarball carries its own
 * provenance.
 *
 * This lives in the staged directory rather than in the tracked provenance.json
 * for two reasons: the sha256 is not stable across builds (the upstream loader
 * does not sort its directory walk, so the stubs are inlined in filesystem
 * order), and a tracked file that changes on every build is churn. The tracked
 * provenance.json still pins the commit both artifacts come from.
 */
const recordProvenance = (ref, staged) => {
  writeFileSync(
    join(stage, 'provenance.json'),
    JSON.stringify(
      {
        source: `https://github.com/${UPSTREAM.owner}/${UPSTREAM.repo}`,
        license: 'Apache-2.0',
        upstreamRef: ref,
        generatedBy: 'scripts/build-server.mjs',
        // Deterministic in content, not in bytes.
        byteReproducible: false,
        targets: staged
      },
      null,
      2
    ) + '\n'
  )
}

/** Copy the licence texts alongside the staged artifact. */
const stageLicences = async () => {
  for (const [from, to] of LICENCES) {
    const source = join(work, from)
    if (!existsSync(source)) {
      throw new Error(`upstream ships no ${from}, which we must carry`)
    }
    await copyFile(source, join(stage, to))
  }
  writeFileSync(join(stage, 'LICENSE.pyright.txt'), PYRIGHT_LICENCE)
}

/** Describe the staged server without rebuilding it. */
const describeStaged = () =>
  TARGETS.map((target) => {
    const file = join(stage, target.to)
    if (!existsSync(file)) {
      throw new Error(`no staged ${target.to}: run with FORCE_SERVER_BUILD=1`)
    }
    return {
      target: target.name,
      file: `server/${target.to}`,
      bytes: readFileSync(file).length,
      sha256: sha256(file)
    }
  })

const report = (staged) => {
  for (const target of staged) {
    console.log(
      `  ${target.target.padEnd(8)} ${String(target.bytes).padStart(10)} bytes  ` +
        `${target.sha256.slice(0, 12)}  ${target.file}`
    )
  }
}

const ref = process.env.UPSTREAM_REF || pinnedRef()
const force = process.env.FORCE_SERVER_BUILD === '1'
const alreadyBuilt = existsSync(marker) && readFileSync(marker, 'utf8').trim() === ref

if (alreadyBuilt && !force) {
  // Reuse the staged server, but still record it: the tarball's provenance
  // describes what it ships, whether or not this run did the compiling.
  console.log(`server: already built from ${ref.slice(0, 10)}, reusing`)
  console.log('  set FORCE_SERVER_BUILD=1 to rebuild')
  const staged = describeStaged()
  await stageLicences()
  recordProvenance(ref, staged)
  report(staged)
  process.exit(0)
}

console.log(`server: building from ${UPSTREAM.owner}/${UPSTREAM.repo}@${ref.slice(0, 10)}`)
build(ref)
const staged = await stageTargets()
await stageLicences()
recordProvenance(ref, staged)
writeFileSync(marker, ref)
report(staged)
