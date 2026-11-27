/**
 * The upstream formatter, bundled.
 *
 * This file is never compiled by `tsc`: it imports the language core out of the
 * upstream source tree, which lives outside `src/` and is fetched at build time.
 * `scripts/build-format.mjs` bundles `src/format.ts` with this file substituted
 * for the `upstream-formatter` specifier, so the published
 * `dist/format.bundle.js` is one self-contained module and the upstream tree is
 * not needed at runtime.
 *
 * The `ResLoader` re-export is deliberate: the lexer reads its vocabulary
 * through that object, and exporting it lets `src/format.ts` point the loader at
 * a data directory instead of at the bundle's own relative path.
 */
export { Formatter } from '../.upstream/server/server/src/sas/formatter/index'
export { getParser } from '../.upstream/server/server/src/sas/formatter/parser'
export { Model } from '../.upstream/server/server/src/sas/Model'
export { SyntaxProvider } from '../.upstream/server/server/src/sas/SyntaxProvider'
export { ResLoader } from '../.upstream/server/server/src/node/ResLoader'
