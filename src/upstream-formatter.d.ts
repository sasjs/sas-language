/**
 * The shape of `upstream-formatter` - the bundle-time alias for the language
 * core in `format/upstream.ts`.
 *
 * Only what `src/format.ts` touches is declared, and only loosely: the upstream
 * types are not part of the published surface, and pinning them here would mean
 * rewriting this file whenever upstream changed a signature. The declarations
 * exist so `tsc` can emit `dist/format.d.ts` for the public API, which is the
 * file consumers actually read.
 */
declare module 'upstream-formatter' {
  export interface FormatOptions {
    /**
     * Prettier's own names, because prettier is what reads them. An index
     * signature used to be here and was worse than useless: it let `tabWidth`
     * and `useTabs` through without proving upstream reads them, so a wrong name
     * would have been accepted by `tsc` and ignored by the printer.
     */
    tabWidth?: number
    useTabs?: boolean
  }

  export interface TextEdit {
    range: {
      start: { line: number; character: number }
      end: { line: number; character: number }
    }
    newText: string
  }

  /** A text buffer, as the formatter's model expects to find it. */
  export interface TextDocumentLike {
    getText(range: {
      start: { line: number; character: number }
      end: { line: number; character: number }
    }): string
    lineCount: number
    offsetAt(position: { line: number; character: number }): number
  }

  export class Model {
    constructor(doc: TextDocumentLike)
    getLine(line: number): string
    getLineCount(): number
    getColumnCount(line: number): number
  }

  export class SyntaxProvider {
    constructor(model: Model)
    setTokenCallback(callback: ((token: unknown) => void) | undefined): void
    /** The token table for one line: a start column and a style per token. */
    getSyntax(line: number): Array<{ start: number; style: string }>
    add(change: {
      text: string
      removedText: string
      oldRange: { start: { line: number; column: number }; end: { line: number; column: number } }
      newRange: { start: { line: number; column: number }; end: { line: number; column: number } }
    }): void
  }

  export interface ParserNode {
    type: string
    name?: string
    text?: string
    start?: { line: number; column: number }
    end?: { line: number; column: number }
    children?: ParserNode[]
  }

  export function getParser(
    model: Model,
    tokens: unknown[],
    syntaxProvider: SyntaxProvider
  ): () => ParserNode

  export class Formatter {
    constructor(model: Model, syntaxProvider: SyntaxProvider)
    format(options: FormatOptions): Promise<TextEdit[]>
  }

  export const ResLoader: {
    get(url: string, callback: (data?: unknown) => void, async?: boolean): void
    getBundle(locale: string): string
  }
}
