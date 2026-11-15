#!/usr/bin/env node
/**
 * Bundles `dist/format.js` - the `formatText` API - into a single module.
 *
 * `src/format.ts` is type-checked and declared by `tsc` like everything else in
 * `src/`, but its implementation lives in the upstream language core: outside
 * `src/`, and only present after `build:server` has fetched it. So the source is
 * bundled by esbuild with `format/upstream.ts` substituted for the
 * `upstream-formatter` specifier - the imports resolve there, the core is
 * inlined, and the published module needs neither the upstream tree nor a
 * relative path into `.upstream/` at runtime. Bundling the source rather than
 * `tsc`'s output keeps this step runnable on its own: there is no intermediate
 * to be stale or missing.
 *
 * The bundle is written to `dist/format.bundle.js` rather than over
 * `dist/format.js`, because `dist/format.js` is `tsc`'s output for the same
 * source: it is the type-checked intermediate, and it still imports the
 * `upstream-formatter` specifier that only this step resolves. `build:ts`
 * regenerates it on every run, so writing the bundle over it would mean
 * whichever step ran last decided what shipped. `dist/format.d.ts` is `tsc`'s
 * declaration output, so consumers read the documented API rather than
 * upstream's types.
 *
 * Why the upstream tree rather than our own esbuild: the core is TypeScript that
 * imports without file extensions and pulls `prettier` from the tree its own
 * build always used. Bundling with that same esbuild, from that same directory,
 * keeps the printer on the same prettier instance as the plugin that builds the
 * document - two copies of `prettier/doc` would print with builders from one and
 * format from the other.
 *
 * Usage:
 *   node scripts/build-format.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const upstream = join(root, '.upstream', 'server')
const upstreamEntry = join(root, 'format', 'upstream.ts')
const sourceEntry = join(root, 'src', 'format.ts')
const types = join(root, 'dist', 'format.d.ts')
const outfile = join(root, 'dist', 'format.bundle.js')
const esbuild = join(upstream, 'node_modules', '.bin', 'esbuild')

const fail = (message) => {
  console.error(`build-format: ${message}`)
  process.exit(1)
}

if (!existsSync(types)) {
  fail(`${types} is missing - run npm run build:ts first, which emits the declarations`)
}

if (!existsSync(upstreamEntry)) {
  fail(`${upstreamEntry} is missing - it is tracked, so the checkout is wrong`)
}

if (!existsSync(join(upstream, 'server', 'src', 'sas', 'formatter', 'index.ts'))) {
  fail(
    `no upstream source at ${join(upstream, 'server', 'src', 'sas')} - ` +
      'run npm run build:server, which fetches the pinned commit and installs what compiles it'
  )
}

if (!existsSync(esbuild)) {
  fail(
    `no esbuild at ${esbuild} - ` +
      'the upstream tree has been fetched but not installed; run npm run build:server'
  )
}

const provenance = JSON.parse(readFileSync(join(root, 'provenance.json'), 'utf8'))
const ref = provenance.upstreamRef.slice(0, 10)
const banner =
  `/*\n * Bundled from the SAS extension for Visual Studio Code\n` +
  ` * (https://github.com/sassoftware/vscode-sas-extension, Apache-2.0)\n` +
  ` * at ${ref}. See NOTICE for the attribution this carries.\n` +
  ` * Built by scripts/build-format.mjs - do not edit.\n */`

execFileSync(
  esbuild,
  [
    sourceEntry,
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--target=node20',
    `--alias:upstream-formatter=${upstreamEntry}`,
    // `utils.ts` reads the localised message bundle with a literal require. The
    // formatter only reaches it when building a message, so the loader exists to
    // keep the import resolvable rather than to be used at speed.
    '--loader:.properties=text',
    `--outfile=${outfile}`,
    `--banner:js=${banner}`,
    '--log-level=warning'
  ],
  { cwd: root, stdio: 'inherit' }
)

rmSync(`${outfile}.map`, { force: true })

// The intermediate is `tsc`'s output for the same source and it imports a
// specifier only this script resolves, so it is of no use in a tarball and
// would look like a broken entry point to anyone who found it. Removing it here
// means `dist/` holds exactly the module the export map names.
for (const leftover of ['format.js', 'format.js.map', 'format.d.ts.map']) {
  rmSync(join(root, 'dist', leftover), { force: true })
}

const bytes = readFileSync(outfile).length
console.log(
  `build-format: dist/format.bundle.js ${(bytes / 1024).toFixed(0)} KB from upstream ${ref}`
)
