/**
 * Keyword casing for the formatter, shared by the node entry and the browser one.
 *
 * The printer preserves whatever case the source used; this pass gives keywords
 * the case the caller asked for. It lives outside `format.ts` because both
 * entries need it and the browser one cannot import `format.ts` - that module
 * imports `node:fs` at the top.
 */
import { documentFrom } from './textDocument.js'

import { Model, SyntaxProvider, getParser } from 'upstream-formatter'

/** The token styles the lexer uses for words SAS does not let you spell freely. */
const KEYWORD_STYLES = new Set([
  'keyword',
  'sec-keyword',
  'proc-name',
  'macro-keyword',
  'macro-sec-keyword'
])

/**
 * Gives keywords the requested case, using the lexer's own token table.
 *
 * A vocabulary of statement names was the first attempt and it was wrong in a way
 * worth recording: the four statement files carry no `ELSE`, no `THEN` and none of
 * the statements that belong to a procedure (`VAR`, `CLASS`), so the output came
 * back half cased - `data` lowercased next to `VAR` untouched. The lexer already
 * knows: every token carries a style, and the ones above are the words SAS reserves.
 *
 * The printed text is lexed and parsed again. The parse identifies verbatim
 * spans that must not be cased and unsafe masking fallbacks that protect the
 * remainder. Keyword tokens outside those spans are edited from the end of
 * each line backwards to keep earlier offsets valid.
 */
export const applyKeywordCase = (text: string, keywordCase: 'upper' | 'lower') => {
  const transform = (word: string) =>
    keywordCase === 'upper' ? word.toUpperCase() : word.toLowerCase()

  const model = new Model(documentFrom(text))
  const syntaxProvider = new SyntaxProvider(model)
  // Re-parse the formatted text using the same lexed tokens that the printer
  // would use. Parser fallback spans cannot be mapped from the original text:
  // formatting can move their start. Case only the prefix when that parser
  // detects an unterminated mask or a token crossing its scanned boundary.
  const lexedTokens: unknown[] = []
  syntaxProvider.setTokenCallback((token) => lexedTokens.push(token))
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

  type Position = { line: number; column: number }
  let unsafe: Position | undefined
  const raw: Array<{ start: Position; end: Position }> = []
  const ast = getParser(
    model,
    lexedTokens,
    syntaxProvider,
    (start) => {
      unsafe = start
    },
    true,
    (start, end) => raw.push({ start, end })
  )()
  type RawNode = {
    type: string
    name?: string
    text?: string
    start?: Position
    end?: Position
    children?: RawNode[]
  }
  const cardsOpeners: Array<{ line: number; start: number; end: number }> = []
  const visit = [ast as RawNode]
  while (visit.length) {
    const node = visit.pop()!
    if (
      node.type === 'statement' &&
      /^(datalines|cards|lines|parmcards)4?$/i.test(node.name ?? '')
    ) {
      const rawNode = node.children?.[0]
      if (rawNode?.type === 'raw-data' && rawNode.start && rawNode.text) {
        const match = /^\s*(datalines|cards|lines|parmcards)4?\b/i.exec(rawNode.text)
        if (match) {
          const word = match[0].trimStart()
          const start = rawNode.start.column + match[0].length - word.length
          cardsOpeners.push({ line: rawNode.start.line, start, end: start + word.length })
        }
      }
    }
    if (node.type === 'raw-data' && node.start && node.end) {
      raw.push({ start: node.start, end: node.end })
    }
    if (node.children) for (const child of node.children) visit.push(child)
  }
  const compare = (a: Position, b: Position) => a.line - b.line || a.column - b.column
  raw.sort((a, b) => compare(a.start, b.start))
  const spans: typeof raw = []
  for (const span of raw) {
    const last = spans[spans.length - 1]
    if (last && compare(span.start, last.end) <= 0) {
      if (compare(span.end, last.end) > 0) last.end = span.end
    } else spans.push({ ...span })
  }
  const overlapsRaw = (start: Position, end: Position) => {
    let lo = 0
    let hi = spans.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compare(spans[mid].start, end) < 0) lo = mid + 1
      else hi = mid
    }
    return lo > 0 && compare(spans[lo - 1].end, start) > 0
  }

  return text
    .split('\n')
    .map((line, index) => {
      const tokens = syntaxProvider.getSyntax(index) ?? []
      let result = line
      for (let at = tokens.length - 1; at >= 0; at--) {
        const token = tokens[at]
        if (!KEYWORD_STYLES.has(token.style)) continue
        const end = at === tokens.length - 1 ? line.length : tokens[at + 1].start
        if (unsafe && (index > unsafe.line || (index === unsafe.line && end > unsafe.column))) {
          continue
        }
        if (overlapsRaw({ line: index, column: token.start }, { line: index, column: end })) {
          continue
        }
        const word = line.slice(token.start, end)
        if (!/[A-Za-z]/.test(word)) continue
        result = result.slice(0, token.start) + transform(word) + result.slice(end)
      }
      for (const opener of cardsOpeners.filter((item) => item.line === index)) {
        if (
          unsafe &&
          (index > unsafe.line || (index === unsafe.line && opener.end > unsafe.column))
        ) {
          continue
        }
        result =
          result.slice(0, opener.start) +
          transform(result.slice(opener.start, opener.end)) +
          result.slice(opener.end)
      }
      return result
    })
    .join('\n')
}
