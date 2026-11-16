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

/** How many fetches one format may make before it gives up, unless the call says. */
const defaultMaxFetches = 40

/** How long one fetch may take before the call fails, in milliseconds. */
const defaultFetchTimeoutMs = 30_000

/** Upstream asks for `../../pubsdata/...`; the cache is keyed without the climb. */
const relative = (url: string) => url.replace(/^(\.\.[/\\])+/, '')

/**
 * The data root a call reads from.
 *
 * An absent root means the default, and so does an empty one: `dataRoot: ''` reads
 * as "no root named" rather than as the origin, which a join would otherwise turn
 * into `/` and then report 404s against a root nobody asked for.
 */
const rootFor = (dataRoot?: string) => {
  const root = dataRoot?.trim() ? dataRoot : defaultDataRoot

  return root.endsWith('/') ? root : `${root}/`
}

/**
 * One request, bounded end to end: the fetch AND the body read.
 *
 * A request that never settles - a connection that stalls, a host that accepts and
 * never answers - would otherwise hold the call open forever, and because formats
 * run one at a time it would hold every later call open with it: the Format button
 * would do nothing, with no error anywhere. A host can also send the headers and
 * then stall the body, so the timer has to cover the read as well; it is cleared
 * only once the caller's `read` has finished with the response.
 *
 * The abort is reported as an error naming the URL and the option that changes the
 * outcome. It does not carry the "serve the folders" advice the 404 does: a root
 * that accepted the connection and never answered is not a root with files absent,
 * and another `dataRoot` is not the fix.
 */
const bounded = async <T>(
  url: string,
  timeoutMs: number,
  read: (response: Response) => Promise<T>
): Promise<T> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await read(await fetch(url, { signal: controller.signal }))
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new Error(
        `SAS language data could not be read: ${url} did not answer within ${
          timeoutMs / 1000
        }s. Raise \`fetchTimeoutMs\` if the host is slow, or check that the data root is answering.`
      )
    }

    // A failure that is not the abort - a CORS refusal, a host that does not
    // resolve, a 200 carrying an HTML fallback - would otherwise reach the caller
    // as the runtime's own `TypeError: Failed to fetch` or `SyntaxError: Unexpected
    // token '<'`, naming neither the file nor the root, which is the opposite of
    // what the docstring promises. The original error is kept as `cause`.
    const wrapped = new Error(
      `SAS language data could not be read: ${url}: ${(error as Error)?.message ?? error}`
    )

    ;(wrapped as Error & { cause?: unknown }).cause = error

    throw wrapped
  } finally {
    clearTimeout(timer)
  }
}

const fetchInto = async (root: string, path: string, timeoutMs: number): Promise<void> => {
  const url = `${root}${path}`

  if (cache.has(url)) return

  const data = await bounded(url, timeoutMs, async (response) => {
    if (!response.ok) {
      throw new Error(
        `SAS language data is missing: ${url} answered ${response.status}. ` +
          `Serve the package's pubsdata and data folders under the data root, or pass \`dataRoot\` to formatText().`
      )
    }

    return response.json()
  })

  cache.set(url, data)
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
  /**
   * How long one fetch may take before the call fails, in milliseconds. Defaults
   * to 30000.
   *
   * A data root that accepts a connection and never answers would otherwise hold
   * the call open - and, because formats run one at a time, every later call with
   * it - so the request is aborted and the call rejects with a sentence naming the
   * file. Raise it for a slow CDN; lower it for a host on the same machine.
   */
  fetchTimeoutMs?: number
  /**
   * How many files one format may fetch before it gives up. Defaults to 40.
   *
   * Each retry costs one file the caller did not have, so this is the ceiling on a
   * first format against a data root that is missing a lot; a host that knows its
   * tree is complete can lower it to fail sooner.
   */
  maxFetches?: number
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
 * the one before it, and nothing else - every fetch is bounded by
 * `fetchTimeoutMs`, so a stalled root fails its own call instead of holding the
 * chain.
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
  const timeoutMs = options.fetchTimeoutMs ?? defaultFetchTimeoutMs
  const budget = options.maxFetches ?? defaultMaxFetches

  installLoader()

  // The loader is a single module-wide hook, so the root of this call is
  // assigned for as long as it runs and put back afterwards - the same shape the
  // node entry uses, and for the same reason.
  dataRoot = root

  try {
    await Promise.all(CORE.map((path) => fetchInto(root, path, timeoutMs)))

    const layout = {
      tabWidth: options.tabWidth ?? 2,
      useTabs: options.useTabs ?? false,
      keywordCase: options.keywordCase ?? 'preserve'
    } as const

    for (let attempt = 0; attempt <= budget; attempt++) {
      try {
        return await print(text, layout)
      } catch (error) {
        if (!(error instanceof MissingData)) throw error

        // The loader throws `MissingData` only when the key it looks up is absent,
        // and that key is `${dataRoot}${path}` with `dataRoot` this call's root - so
        // every iteration fetches a file it did not have, which is what the budget
        // counts. Stop before the fetch that no attempt would follow: spending it
        // and then reporting the budget would tell the caller a file was missing
        // that had just been fetched.
        if (attempt === budget) break

        await fetchInto(root, error.path, timeoutMs)
      }
    }
  } finally {
    if (dataRoot === root) dataRoot = previous
  }

  throw new Error(
    `SAS language data is missing: formatting asked for more than ${budget} file(s). ` +
      `Check that the data root serves the whole pubsdata and data tree.`
  )
}
