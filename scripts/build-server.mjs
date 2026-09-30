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
import { copyFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { UPSTREAM } from './groups.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(root, '.upstream', 'server')
const marker = join(work, '.built-from')
const stage = join(root, 'server')

const TARGETS = [
  { name: 'browser', from: 'server/dist/browser/server.js', to: 'browser/server.js' },
  {
    name: 'node',
    from: 'server/dist/node/server.js',
    // The node bundle resolves its runtime files relative to itself, and the
    // upstream build places it at server/dist/node/. The staged tree mirrors
    // that depth exactly, so every relative path the bundle computes - the
    // impl/ and typeshed-fallback/ directories beside it, the pubsdata/ and
    // data/ trees two levels up, the message bundles - resolves to a file
    // that exists here too.
    to: 'node/dist/node/server.js'
  }
]

/**
 * The node build loads parts of itself and its data from disk at runtime:
 *
 * - impl/ and typeshed-fallback/ beside the bundle
 * - two levels up from the bundle, which is server/node/dist/ in the staged
 *   tree: the SAS documentation tree (pubsdata/), the runtime data (data/),
 *   and the localised message bundles. The browser build inlines all of it,
 *   so it stays a single file.
 */
const NODE_RUNTIME_DIRS = ['impl', 'typeshed-fallback']
const NODE_PARENT_DATA = ['pubsdata', 'data', 'messagebundle.properties']

/**
 * The package root declares "type": "module" for the TypeScript build, which
 * makes node parse every .js under it as ESM. The server bundles are
 * CommonJS, so the node target carries a local package.json that restores
 * CommonJS parsing for its own directory. Without it, node rejects the
 * server at startup with "require is not defined in ES module scope".
 */
const NODE_CJS_MARKER = JSON.stringify({ type: 'commonjs' }, null, 2) + '\n'

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

/**
 * The upstream build dispatches on npm's own config variables: it runs its
 * sub-builds as `npm run compile --webviews` and reads the result back from
 * `process.env.npm_config_webviews`.
 *
 * npm forwards such a flag to the script up to npm 11. npm 12 rejects it with
 * EUNKNOWNCONFIG, which is how a release failed while CI, on the npm bundled with
 * node 22, stayed green. Passing the flag after `--` gets it to the script on
 * every npm, but leaves the environment variable unset, so the parent branch
 * re-runs itself and the build never terminates.
 *
 * The dispatch is therefore rewritten to take the target from the command line or
 * the environment, and the sub-builds are invoked with the separator form. Every
 * replacement is asserted, so an upstream change to any of these call sites fails
 * the build here rather than in a release.
 */
const SUB_BUILD_PATCHES = [
  // The target arrives as an npm config flag, which the parent branch turns into
  // `npm_config_<target>` in the child's environment. Read it from the command
  // line as well, and keep `dev` from being confused for a target.
  [
    'const dev = process.argv[2];',
    `const args = process.argv.slice(2);
const subBuilds = ["static", "webviews", "client"];
const target = subBuilds.find(
  (name) => args.includes(\`--\${name}\`) || process.env[\`npm_config_\${name}\`],
);
const dev = args.includes("dev");`
  ],
  ['if (process.env.npm_config_static) {', 'if (target === "static") {'],
  [
    '} else if (process.env.npm_config_webviews || process.env.npm_config_client) {',
    '} else if (target) {'
  ],
  [
    'process.env.npm_config_webviews ? browserBuildOptions : nodeBuildOptions',
    'target === "webviews" ? browserBuildOptions : nodeBuildOptions'
  ],
  // The sub-build invocations themselves, in the form every npm accepts.
  [
    'npm run ${process.env.npm_lifecycle_event} --webviews',
    'npm run ${process.env.npm_lifecycle_event} -- --webviews'
  ],
  [
    'npm run ${process.env.npm_lifecycle_event} --client',
    'npm run ${process.env.npm_lifecycle_event} -- --client'
  ],
  [
    'npm run ${process.env.npm_lifecycle_event} --static',
    'npm run ${process.env.npm_lifecycle_event} -- --static'
  ]
]

const patchSubBuildDispatch = () => {
  const file = join(work, 'tools', 'build.mjs')
  let source = readFileSync(file, 'utf8')
  for (const [from, to] of SUB_BUILD_PATCHES) {
    if (!source.includes(from)) {
      throw new Error(
        `upstream tools/build.mjs does not contain ${JSON.stringify(from)}, ` +
          'so the sub-build dispatch patch did not apply'
      )
    }
    source = source.split(from).join(to)
  }
  writeFileSync(file, source)
}

const build = (ref) => {
  prepareSource(ref)
  patchSubBuildDispatch()

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

/**
 * Stages the node build's runtime directories beside its entry point. The
 * node build loads parts of itself from disk at runtime: the SAS formatter's
 * impl/ modules and the typeshed Python stubs. The browser build inlines
 * both, so it stays a single file.
 */
const stageNodeRuntimeDirs = async () => {
  const bundleDir = join(stage, 'node', 'dist', 'node')
  // The bundle resolves its data two levels up from itself. It sits at
  // server/node/dist/node/server.js, so two levels up is server/node/ - the
  // same shape upstream produces with server/dist/node/ under server/.
  const parentDir = join(stage, 'node')

  for (const dir of NODE_RUNTIME_DIRS) {
    const from = join(work, 'server/dist/node', dir)
    if (!existsSync(from)) {
      throw new Error(`node build produced no ${dir}/`)
    }
    await copyDir(from, join(bundleDir, dir))
  }

  // The data the bundle resolves two levels up. The upstream tree keeps it
  // under server/, so the staged tree keeps it under server/node/dist/.
  for (const name of NODE_PARENT_DATA) {
    const source = join(work, 'server', name)
    if (!existsSync(source)) {
      throw new Error(`upstream tree has no ${name}, which the node server reads`)
    }
    if (name.endsWith('.properties')) {
      await copyFile(source, join(parentDir, name))
    } else {
      await copyDir(source, join(parentDir, name))
    }
  }

  writeFileSync(join(bundleDir, 'package.json'), NODE_CJS_MARKER)
}

/**
 * Copies a directory tree, creating the destination as needed.
 */
const copyDir = async (from, to) => {
  mkdirSync(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const destination = join(to, entry.name)
    if (entry.isDirectory()) {
      await copyDir(source, destination)
    } else {
      await copyFile(source, destination)
    }
  }
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

  // Both the fresh-build and the reuse path stage these, so a reused build
  // ships the same layout a fresh one does.
  await stageNodeRuntimeDirs()

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
  // Reuse the upstream build, but still stage and record it: the tarball's
  // provenance describes what it ships, whether or not this run did the
  // compiling.
  console.log(`server: already built from ${ref.slice(0, 10)}, reusing`)
  console.log('  set FORCE_SERVER_BUILD=1 to rebuild')
  const staged = await stageTargets()
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
