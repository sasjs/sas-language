/**
 * SAS formatting in a browser: the same call as `./format`, with the vocabulary
 * fetched instead of read from disk.
 *
 * The node entry resolves its data root from the bundle's own location and reads
 * each file synchronously through `ResLoader`. That seam is synchronous because
 * the lexer calls it mid-tokenise and needs the JSON back before the call
 * returns - which is why `src/format.ts` says the module is node-only, and why
 * the browser's answer to the same question was "ask a node host for it".
 *
 * Asking a node host is exactly what a browser consumer pays for today: SASjs
 * Server's Studio posts the whole program to `/SASjsApi/code/format` to have it
 * re-indented, and a mock site - which has no HTTP API behind it at all - cannot
 * format, because indentation only comes from this engine.
 *
 * This entry turns the problem around. Nothing formats until the files the lexer
 * will ask for are already in memory, and then the same synchronous loader
 * answers from that cache:
 *
 *   1. the core set is fetched up front - the procedures index, the statement and
 *      function files, which is what a DATA step needs (~2.2 MB, cached for the
 *      life of the page)
 *   2. the formatter runs; anything else it asks for (a `PROC` step's procedure
 *      file, a vocabulary file from `data/`) is a miss, and a miss is reported as
 *      `MissingData` carrying the path
 *   3. the caller fetches that path and runs again
 *
 * The retry loop is what keeps this honest: it depends on nothing but what the
 * formatter itself asks for, so a new vocabulary file upstream costs one extra
 * fetch on the first format that needs it rather than a build-time list that
 * silently goes stale. `maxFetches` bounds a first format against a runaway.
 *
 * What the data root must serve, measured on the staged tree rather than assumed:
 *
 *   pubsdata/procedures.json                  ~0.4 MB   valid PROC names
 *   pubsdata/Statements/en/*.json             ~1.5 MB   four files
 *   pubsdata/Functions/en/*.json              ~0.7 MB   two files
 *   pubsdata/Procedures/en/<PROC>.json        ~38 KB each, fetched per PROC used
 *   data/*.json                               ~4.3 MB   fetched on demand
 *
 * The default root is `/sas-language/`, so a host that copies the package's
 * `server/node` tree (or just its `pubsdata` and `data` folders) under that path
 * needs no configuration. Pass `dataRoot` to serve it from somewhere else; it is
 * a URL, not a directory.
 */
import { applyEdits, documentFrom } from './textDocument.js'
import { applyKeywordCase } from './format.keywordCase.js'

import { Formatter, Model, SyntaxProvider } from 'upstream-formatter'
import { ResLoader } from 'browser-formatter-loader'

/** Where `formatText` fetches the vocabulary from, unless the call names a root. */
export const defaultDataRoot = '/sas-language/'

/**
 * A file the formatter asked for that has not been fetched yet.
 *
 * Carried as its own type so `formatText` can tell "fetch this and try again"
 * apart from a real failure; the message is what a caller sees when the retry
 * budget runs out.
 */
export class MissingData extends Error {
  readonly path: string

  constructor(path: string) {
    super(
      `SAS language data is missing: ${path} has not been fetched. ` +
        `Serve the package's pubsdata and data folders under the data root, or pass \`dataRoot\` to formatText().`
    )
    this.name = 'MissingData'
    this.path = path
  }
}

/**
 * The files a DATA step needs, relative to the data root.
 *
 * These are fetched before the first attempt rather than discovered by the retry
 * loop, because every program asks for them: one parallel batch, once, instead of
 * a serial miss-and-retry for each.
 */
const CORE = [
  'pubsdata/procedures.json',
  'pubsdata/Statements/en/datastep.json',
  'pubsdata/Statements/en/macro.json',
  'pubsdata/Statements/en/global.json',
  'pubsdata/Statements/en/standalone.json',
  'pubsdata/Functions/en/base.json',
  'pubsdata/Functions/en/macro.json'
]

/**
 * The fetched vocabulary, keyed by root and path.
 *
 * The root is part of the key because one page can talk to more than one data
 * root - a CDN beside the app's own copy - and a key of the path alone would let
 * the second root answer out of the first one's vocabulary, formatting with the
 * wrong data and no error anywhere.
 */
const cache = new Map<string, unknown>()

/** Locale bundles are only used for human-readable errors; absent is fine. */
const bundles = new Map<string, string>()

/** How many fetches one format may make before it gives up. */
const maxFetches = 40

/** Upstream asks for `../../pubsdata/...`; the cache is keyed without the climb. */
const relative = (url: string) => url.replace(/^(\.\.[/\\])+/, '')

const rootFor = (dataRoot?: string) =>
  (dataRoot ?? defaultDataRoot).endsWith('/') ? (dataRoot ?? defaultDataRoot) : `${dataRoot}/`

const fetchInto = async (root: string, path: string): Promise<void> => {
  if (cache.has(`${root}${path}`)) return

  const response = await fetch(`${root}${path}`)

  if (!response.ok) {
    throw new Error(
      `SAS language data is missing: ${root}${path} answered ${response.status}. ` +
        `Serve the package's pubsdata and data folders under the data root, or pass \`dataRoot\` to formatText().`
    )
  }

  cache.set(`${root}${path}`, await response.json())
}

/**
 * Points the core's loader at the cache.
 *
 * Installed once: `ResLoader` is a single object shared by every module the
 * bundle carries, so the functions only have to be assigned the first time.
 * What they read changes per call, because the cache outlives the call.
 */
let loaderInstalled = false

/** The root of the call in progress: the loader reads through it. */
let dataRoot = defaultDataRoot

const installLoader = () => {
  if (loaderInstalled) return

  ResLoader.get = (url: string, callback: (data?: unknown) => void) => {
    const path = relative(url)
    const key = `${dataRoot}${path}`

    if (!cache.has(key)) throw new MissingData(path)

    callback(cache.get(key))
  }

  ResLoader.getBundle = (locale: string) => bundles.get(locale) ?? ''

  loaderInstalled = true
}

/** One formatting pass. Synchronous inside, so nothing else runs mid-lex. */
const print = async (
  text: string,
  options: { tabWidth: number; useTabs: boolean; keywordCase: 'upper' | 'lower' | 'preserve' }
): Promise<string> => {
  const model = new Model(documentFrom(text))
  const syntaxProvider = new SyntaxProvider(model)
  const formatter = new Formatter(model, syntaxProvider)

  const lastLine = model.getLineCount() - 1
  syntaxProvider.add({
    text: '',
    removedText: '',
    oldRange: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
    newRange: {
      start: { line: 0, column: 0 },
      end: { line: lastLine, column: model.getColumnCount(lastLine) }
    }
  })

  const edits = await formatter.format({
    tabWidth: options.tabWidth,
    useTabs: options.useTabs
  })

  const formatted = applyEdits(text, edits)

  return options.keywordCase === 'preserve'
    ? formatted
    : applyKeywordCase(formatted, options.keywordCase)
}

export interface FormatOptions {
  /** Indentation width. Defaults to 2, the upstream default. */
  tabWidth?: number
  /** Indent with tabs rather than spaces. Defaults to false. */
  useTabs?: boolean
  /**
   * Where `pubsdata/` and `data/` are served from. A URL: the default is
   * `/sas-language/`, and the path is joined with a `/` if the caller's does not
   * end with one.
   */
  dataRoot?: string
  /** Case to give keywords. Defaults to `preserve`. */
  keywordCase?: 'upper' | 'lower' | 'preserve'
}

/**
 * Formats run one at a time.
 *
 * The core's loader is a single object shared by every module the bundle carries,
 * so the root a call assigns is visible to any other call in flight: two calls with
 * different roots would swap each other's vocabulary and format with the wrong
 * data, with nothing to see afterwards. Queueing costs one call's latency behind
 * the one before it, and nothing else.
 */
let queue: Promise<unknown> = Promise.resolve()

/**
 * Formats a SAS program in the browser and returns the text.
 *
 * Fetches what the formatter needs, formats, and retries on a miss - so the first
 * format of a program makes a handful of requests and every later one makes none.
 * Nothing is fetched twice, and the cache lives for the life of the page.
 *
 * Returns the input unchanged when the printer produces no edit, which happens
 * for empty input and for a buffer the parser cannot make sense of.
 *
 * Throws when the data root does not answer, naming the file and the status: a
 * formatter that returned the buffer unchanged in that case would look like it
 * had worked.
 */
export const formatText = (text: string, options: FormatOptions = {}): Promise<string> => {
  const run = queue.then(() => formatNow(text, options))

  // the chain has to outlive a call that throws, or one failed format would stop
  // every later one from starting
  queue = run.then(
    () => undefined,
    () => undefined
  )

  return run
}

/** One call's work, with every earlier call finished behind it. */
const formatNow = async (text: string, options: FormatOptions): Promise<string> => {
  const root = rootFor(options.dataRoot)
  const previous = dataRoot

  installLoader()

  // The loader is a single module-wide hook, so the root of this call is
  // assigned for as long as it runs and put back afterwards - the same shape the
  // node entry uses, and for the same reason.
  dataRoot = root

  try {
    await Promise.all(CORE.map((path) => fetchInto(root, path)))

    const layout = {
      tabWidth: options.tabWidth ?? 2,
      useTabs: options.useTabs ?? false,
      keywordCase: options.keywordCase ?? 'preserve'
    } as const

    for (let attempt = 0; attempt <= maxFetches; attempt++) {
      try {
        return await print(text, layout)
      } catch (error) {
        if (!(error instanceof MissingData)) throw error

        await fetchInto(root, error.path)
      }
    }
  } finally {
    if (dataRoot === root) dataRoot = previous
  }

  throw new Error(
    `SAS language data is missing: formatting asked for more than ${maxFetches} files. ` +
      `Check that the data root serves the whole pubsdata and data tree.`
  )
}
