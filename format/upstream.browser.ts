/**
 * The upstream formatter, bundled for a browser.
 *
 * The node counterpart is `format/upstream.ts`, and the difference is one
 * re-export: `ResLoader` is absent because the core imports it from
 * `node/ResLoader` in two places, which would pull `fs` into the bundle.
 * `scripts/build-format-browser.mjs` rewrites those two imports to
 * `format/resLoader.browser.ts`, and `src/format.browser.ts` fills that object
 * in with a loader backed by fetched data.
 */
export { Formatter } from '../.upstream/server/server/src/sas/formatter/index'
export { getParser } from '../.upstream/server/server/src/sas/formatter/parser'
export { Model } from '../.upstream/server/server/src/sas/Model'
export { SyntaxProvider } from '../.upstream/server/server/src/sas/SyntaxProvider'
