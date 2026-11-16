/**
 * The shape of `browser-formatter-loader` - the bundle-time alias for
 * `format/resLoader.browser.ts`.
 *
 * The browser bundle rewrites the core's `../node/ResLoader` imports to that
 * file, because the node one imports `fs` and would make the module unbuildable
 * for a browser. `src/format.browser.ts` fills the object in for each call, so
 * all it needs from the module is the mutable object.
 */
declare module 'browser-formatter-loader' {
  export const ResLoader: {
    get(url: string, callback: (data?: unknown) => void, async?: boolean): void
    getBundle(locale: string): string
  }
}
