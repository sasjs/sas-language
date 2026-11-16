/**
 * The loader the language core reads its vocabulary through, in a browser.
 *
 * Upstream keeps two implementations: `node/ResLoader.ts` reads with `fs`, and
 * `browser/ResLoader.ts` bundles the whole vocabulary with webpack `require`s
 * so the language server's worker can answer synchronously. Neither fits a
 * caller that has the data on a web server and wants it on demand, which is the
 * case this entry exists for - so the object is created empty here and
 * `format.browser.ts` fills it in for each call.
 *
 * The shape is upstream's, including the callback: the lexer calls `get` and
 * expects the parsed JSON to have been handed back before the call returns.
 */
export const ResLoader = {
  get: (_url: string, _callback: (data?: unknown) => void, _async?: boolean) => {
    throw new Error(
      'SAS language data is missing: the browser loader was called before ' +
        'formatText() installed it. Call formatText() from "@sasjs/sas-language/format" ' +
        'in a browser rather than importing the core directly.'
    )
  },
  getBundle: (_locale: string): string => ''
}
