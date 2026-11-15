#!/usr/bin/env node
/**
 * Asserts that everything the package promises is actually in the tarball.
 *
 * 0.5.0 reached npm without `dist/format.bundle.js` while `exports["./format"]`
 * named it, so `import '@sasjs/sas-language/format'` failed for every consumer.
 * The publish step's own gate could not catch it: the gate was a hand-written
 * list of paths, and the bundle was not on the list. A list that is maintained
 * by hand next to a package.json that names the same files will drift, and the
 * drift is invisible until someone installs the result.
 *
 * So the list is not written down here either. It is derived from
 * `package.json`'s `exports` map - the promise - and checked against the file
 * list `npm pack --dry-run --json` reports - what the tarball would contain.
 * Add an entry point and this check covers it without being edited.
 *
 * `INTERNAL` holds the paths a consumer cannot import but which the entry points
 * need on disk at runtime: the node server reads its data tree and message
 * bundles through relative paths, and the declarations file is what gives
 * `./format` its types.
 *
 * Usage:
 *   node scripts/verify-pack.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * Paths the entry points need but no consumer imports. The node server resolves
 * these relative to its own bundle, so a tarball without them installs cleanly
 * and fails on the first request.
 */
const INTERNAL = [
  'server/node/pubsdata/procedures.json',
  'server/node/messagebundle.properties',
  'dist/format.d.ts'
]

/** Every file path the exports map promises, as tarball-relative paths. */
const promised = () => {
  const required = new Set()
  const wildcards = []

  const addTargets = (target, key) => {
    if (typeof target === 'string') {
      if (target.includes('*')) {
        wildcards.push({ key, base: target.slice(0, target.indexOf('*')).replace(/^\.\//, '') })
      } else required.add(target.replace(/^\.\//, ''))
      return
    }
    for (const [condition, value] of Object.entries(target ?? {})) {
      // Only the conditions a runtime or a type resolver actually reads.
      if (condition === 'types' || condition === 'default' || condition === 'import') {
        addTargets(value, key)
      }
    }
  }

  for (const [key, target] of Object.entries(manifest.exports ?? {})) addTargets(target, key)
  for (const path of INTERNAL) required.add(path)

  return { required: [...required].sort(), wildcards }
}

const packed = (() => {
  // --ignore-scripts: the pack must not rebuild anything, or the check would be
  // testing a build rather than the artifact list.
  const json = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const [report] = JSON.parse(json)
  return { files: report.files.map((entry) => entry.path), count: report.files.length }
})()

const present = new Set(packed.files)
const { required, wildcards } = promised()

const problems = []
for (const path of required) {
  if (!present.has(path)) problems.push(`missing from the tarball: ${path}`)
}
for (const { key, base } of wildcards) {
  if (!packed.files.some((path) => path.startsWith(base))) {
    problems.push(`nothing under ${base} for the wildcard export ${key}`)
  }
}

// A path can be in the list and still be empty, which publishes a file that
// exists and cannot be used.
for (const path of required) {
  const onDisk = join(root, path)
  if (present.has(path) && existsSync(onDisk) && readFileSync(onDisk).length === 0) {
    problems.push(`empty file: ${path}`)
  }
}

if (problems.length) {
  console.error('verify-pack: the package would publish without what it promises')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error(`\n${packed.count} files in the tarball; ${required.length} paths promised.`)
  process.exit(1)
}

console.log(
  `verify-pack: ${required.length} promised paths and ${wildcards.length} wildcard ` +
    `export(s) present in ${packed.count} packaged files`
)
