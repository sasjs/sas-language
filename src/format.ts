/**
 * SAS formatting, as a function you can call.
 *
 * The formatter ships inside the language server - it is a prettier printer over
 * a SAS AST, and until now the only way to reach it was to start that server and
 * speak LSP to it. That rules out everything without a language server: a CLI in
 * CI has no way to ask, and a server-side job that wants to format a buffer it
 * just received has to spawn a whole process for it. This entry point is the
 * call those host-side consumers share.
 *
 * It is a **node** API: it reads the vocabulary from disk with `node:fs`, and the
 * published module is built for node. A browser cannot load it, and does not
 * need to - a browser editor keeps the webworker language server it already runs,
 * and a browser product that wants this formatter asks a node host for it.
 *
 * Formatting one buffer takes four steps, in this order, and none is optional:
 *
 *   1. a `Model` over the text - the formatter prints from the model, not from
 *      its input argument, which the server passes as the literal string "text"
 *   2. a `SyntaxProvider` over the model, which owns the lexer
 *   3. one full-document change pushed through `syntaxProvider.add()`, which is
 *      what makes the lexer tokenise the buffer; `add()` parses synchronously,
 *      so the tokens are ready before the next line runs
 *   4. the `Formatter`, which prints the AST back as text
 *
 * The vocabulary is not compiled into the printer. The lexer reads it on demand
 * through `ResLoader`, and the node implementation of that loader `require`s
 * paths relative to its own bundle, which is why the staged server has to sit at
 * exactly its upstream depth. The published module is `dist/format.bundle.js`
 * instead, so the loader is replaced here with one that resolves the same paths
 * against a data root.
 *
 * What that root must contain, measured rather than assumed:
 *
 *   pubsdata/Statements, pubsdata/Functions, pubsdata/procedures.json   ~2.2 MB
 *     enough to format a DATA step; with these alone a program containing a
 *     PROC step throws, naming the procedure file it could not read
 *   pubsdata/Procedures/en/<PROC>.json                                 ~38 KB each
 *     loaded only for the procedures a file actually uses - a general-purpose
 *     formatter therefore needs all 423 of them, ~16 MB
 *   data/                                                              ~1.2 MB
 *
 * The server tree this package already stages has all of it at
 * `server/node/pubsdata` and `server/node/data`, so the default root is that
 * directory and a caller who has installed the package needs to configure
 * nothing. A caller who ships the vocabulary elsewhere passes `dataRoot`.
 *
 * One known limit, inherited from upstream: the printer preserves keyword case.
 * Lowercase keywords in produce lowercase keywords out, and there is no option
 * to ask for a particular case. That is why casing belongs to the rules layer
 * above this one rather than here.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyEdits, documentFrom } from './textDocument.js'

import { Formatter, Model, ResLoader, SyntaxProvider } from 'upstream-formatter'

export interface FormatOptions {
  /**
   * Indentation width. Defaults to 2, the upstream default.
   *
   * Named as prettier names it, because prettier's options are what the printer
   * reads: an LSP client passes `tabSize` and `insertSpaces`, and the mapping
   * (`tabWidth` = tabSize, `useTabs` = !insertSpaces) belongs to the host that
   * speaks LSP rather than to this function.
   */
  tabWidth?: number
  /** Indent with tabs rather than spaces. Defaults to false. */
  useTabs?: boolean
  /** Directory holding `pubsdata/` and `data/`. Defaults to the staged server tree. */
  dataRoot?: string
}

/**
 * The directory this package stages the language data in.
 *
 * `dist/format.bundle.js` sits one level below the package root, which is also
 * where `server/node/` sits, so the default needs no configuration in the common
 * case.
 */
export const defaultDataRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'server',
  'node'
)

/**
 * The root the installed loader reads from, set by each call before it formats.
 *
 * It is module state because `ResLoader.get` is a single process-wide hook - the
 * only seam the language core offers - so the root cannot travel with a call.
 * Each call therefore assigns it up front and restores it afterwards, which is
 * what stops one caller's root from outliving that caller.
 *
 * The vocabulary behind the hook is cached for the life of the process, so a
 * root only decides where a file is read from the first time it is needed. A
 * second call with a different root reuses everything the first one loaded.
 */
let dataRoot = defaultDataRoot
let loaderInstalled = false

/**
 * Replaces the upstream loader with one that reads the same files from
 * `dataRoot` instead of from paths relative to the bundle.
 *
 * `ResLoader` is the single data hook in the language core: the lexer asks it
 * for `../../pubsdata/<...>.json` whether it is running under node or in a
 * worker, and the two implementations differ only in how they turn that path
 * into bytes. Overriding `get` therefore changes where the vocabulary comes from
 * without touching anything that consumes it.
 */
const installLoader = () => {
  if (loaderInstalled) return

  ResLoader.get = (url: string, callback: (data?: unknown) => void) => {
    const relative = url.replace(/^(\.\.[/\\])+/, '')
    const file = join(dataRoot, relative)
    // Thrown rather than returned: a read that fails here has to reach the
    // caller. Measured, because it is not obvious - a buffer whose PROC step
    // needs a procedure file this root does not have rejects with this message,
    // naming the file. The server returns no edits in the same situation because
    // it catches around lexing, which is why the two behave differently.
    let contents: string
    try {
      contents = readFileSync(file, 'utf8')
    } catch (error) {
      throw new Error(
        `SAS language data is missing: cannot read ${file}. ` +
          `Install this package's server tree or pass \`dataRoot\` to formatText().`
      )
    }
    callback(JSON.parse(contents))
  }

  // Localised message bundles are read by the same module. They are only used
  // for human-readable errors, so a missing bundle is not worth failing over.
  ResLoader.getBundle = (locale: string) => {
    try {
      return readFileSync(join(dataRoot, `messagebundle_${locale}.properties`), 'utf8')
    } catch {
      return ''
    }
  }

  loaderInstalled = true
}

const assertDataRoot = (root: string) => {
  const marker = join(root, 'pubsdata', 'procedures.json')
  if (!existsSync(marker)) {
    throw new Error(
      `SAS language data is missing: ${marker} does not exist. ` +
        `Install this package's server tree or pass \`dataRoot\` to formatText().`
    )
  }
}

/**
 * Formats a SAS program and returns the text.
 *
 * Returns the input unchanged when the formatter produces no edit, which happens
 * for empty input and for a buffer the parser cannot make sense of. A caller
 * that needs to know which of those happened should compare the strings.
 *
 * `dataRoot` applies to this call: the loader's root is assigned before the
 * buffer is lexed and restored when the call ends, including when it throws.
 * Lexing happens in that window rather than after an await, so nothing else can
 * run while the root is in force; the vocabulary it loads is cached for the
 * process, and a later call reuses it whatever root it passes.
 *
 * A buffer whose PROC step needs a procedure file the root does not have throws,
 * naming the file - it does not come back unformatted.
 */
export const formatText = (text: string, options: FormatOptions = {}): Promise<string> => {
  const root = options.dataRoot ? resolve(options.dataRoot) : defaultDataRoot

  const run = async (): Promise<string> => {
    installLoader()
    const previous = dataRoot
    dataRoot = root
    try {
      assertDataRoot(root)

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
        tabWidth: options.tabWidth ?? 2,
        useTabs: options.useTabs ?? false
      })

      return applyEdits(text, edits)
    } finally {
      // Only put back what this call set. An overlapping call assigns its own
      // root and its own `previous`, so restoring unconditionally would leave the
      // module pinned to whichever call finished first.
      if (dataRoot === root) dataRoot = previous
    }
  }

  return run()
}
