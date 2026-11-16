#!/usr/bin/env node
/**
 * Bundles `src/format.browser.ts` into `dist/format.browser.bundle.js`.
 *
 * The node build (`build-format.mjs`) and this one share an entry shape and
 * differ in three things, each of which is the point of the file:
 *
 * - `platform: 'browser'`, so esbuild refuses a node builtin instead of
 *   resolving one. That is the guard: if a change upstream or here reintroduces
 *   an `fs` import, this build fails rather than shipping a module whose first
 *   call dies in a browser with "Can't resolve 'fs'".
 * - the core's `../node/ResLoader` imports are rewritten to
 *   `format/resLoader.browser.ts`. The core imports that path directly in two
 *   files, so an alias on the bare specifier cannot reach it; a plugin can.
 * - `upstream-formatter` maps to `format/upstream.browser.ts`, which is
 *   `format/upstream.ts` without its `ResLoader` re-export - the same reason,
 *   one import earlier.
 *
 * Usage:
 *   node scripts/build-format-browser.mjs
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const upstream = join(root, '.upstream', 'server')
const upstreamEntry = join(root, 'format', 'upstream.browser.ts')
const loaderEntry = join(root, 'format', 'resLoader.browser.ts')
const sourceEntry = join(root, 'src', 'format.browser.ts')
const types = join(root, 'dist', 'format.browser.d.ts')
const outfile = join(root, 'dist', 'format.browser.bundle.js')
const esbuildModule = join(upstream, 'node_modules', 'esbuild', 'lib', 'main.js')

const fail = (message) => {
  console.error(`build-format-browser: ${message}`)
  process.exit(1)
}

if (!existsSync(types)) {
  fail(`${types} is missing - run npm run build:ts first, which emits the declarations`)
}

if (!existsSync(upstreamEntry) || !existsSync(loaderEntry)) {
  fail('format/upstream.browser.ts or format/resLoader.browser.ts is missing')
}

if (!existsSync(join(upstream, 'server', 'src', 'sas', 'formatter', 'index.ts'))) {
  fail(
    `no upstream source at ${join(upstream, 'server', 'src', 'sas')} - ` +
      'run npm run build:server, which fetches the pinned commit and installs what compiles it'
  )
}

if (!existsSync(esbuildModule)) {
  fail(
    `no esbuild at ${esbuildModule} - ` +
      'the upstream tree has been fetched but not installed; run npm run build:server'
  )
}

const provenance = JSON.parse(readFileSync(join(root, 'provenance.json'), 'utf8'))
const ref = provenance.upstreamRef.slice(0, 10)
const banner =
  `/*\n * Bundled from the SAS extension for Visual Studio Code\n` +
  ` * (https://github.com/sassoftware/vscode-sas-extension, Apache-2.0)\n` +
  ` * at ${ref}. See NOTICE for the attribution this carries.\n` +
  ` * Built by scripts/build-format-browser.mjs - do not edit.\n */`

const { build } = await import(`file://${esbuildModule}`)

/**
 * Points the core's own `ResLoader` imports at the browser loader.
 *
 * Both are relative specifiers (`../node/ResLoader`), which an alias cannot
 * match, so the resolution is done here. A miss returns `undefined` and lets
 * esbuild carry on with its own resolution.
 */
const browserLoader = {
  name: 'browser-loader',
  setup(api) {
    api.onResolve({ filter: /\/node\/ResLoader$/ }, (args) => {
      if (!args.importer.endsWith('.ts')) return
      if (!args.importer.includes(`${join('server', 'src')}`)) return

      return { path: loaderEntry }
    })
  }
}

await build({
  entryPoints: [sourceEntry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  alias: {
    'upstream-formatter': upstreamEntry,
    'browser-formatter-loader': loaderEntry
  },
  // `utils.ts` reads the localised message bundle with a literal require; the
  // loader exists to keep the import resolvable rather than to be used.
  loader: { '.properties': 'text' },
  banner: { js: banner },
  plugins: [browserLoader],
  logLevel: 'warning'
})

rmSync(`${outfile}.map`, { force: true })

// `tsc` emits `dist/format.browser.js` for the same source, and that file
// imports the two bundle-time specifiers only this script resolves - so it is of
// no use in a tarball and would shadow the module the export map names if it
// were left beside it. The declarations ARE shipped: they describe this entry's
// signature (`dataRoot` as a URL, `fetchTimeoutMs`) which the node build's
// `format.d.ts` does not, and the export map names them under `browser`.
for (const leftover of ['format.browser.js', 'format.browser.js.map']) {
  rmSync(join(root, 'dist', leftover), { force: true })
}

const bytes = readFileSync(outfile).length
console.log(
  `build-format-browser: dist/format.browser.bundle.js ${(bytes / 1024).toFixed(0)} KB from upstream ${ref}`
)
