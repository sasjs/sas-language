/**
 * Keyword casing for the formatter, shared by the node entry and the browser one.
 *
 * The printer preserves whatever case the source used; this pass gives keywords
 * the case the caller asked for. It lives outside `format.ts` because both
 * entries need it and the browser one cannot import `format.ts` - that module
 * imports `node:fs` at the top.
 */
import { documentFrom } from './textDocument.js'

import { getParser, Model, SyntaxProvider, type ParserNode } from 'upstream-formatter'

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
 * So the printed text is lexed once more - no printing, just the token table - and
 * the spans it marks are rewritten. Editing from the end of each line backwards
 * keeps the earlier offsets valid, and a token holding no letters (a semicolon, a
 * `%` sigil) is skipped rather than cased into nonsense.
 */
export const applyKeywordCase = (text: string, keywordCase: 'upper' | 'lower') => {
  const transform = (word: string) =>
    keywordCase === 'upper' ? word.toUpperCase() : word.toLowerCase()

  const document = documentFrom(text)
  const model = new Model(document)
  const syntaxProvider = new SyntaxProvider(model)
  const parserTokens: unknown[] = []
  syntaxProvider.setTokenCallback((token) => parserTokens.push(token))
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

  // The same parser used by the printer identifies verbatim regions, including
  // cards data through EOF when a lexer token crosses a terminator. Reusing its
  // spans avoids a second, conflicting interpretation of raw SAS data.
  const protectedSpans: Array<{ start: number; end: number }> = []
  const cardsOpeners: Array<{ line: number; start: number; end: number }> = []
  const offset = (pos: { line: number; column: number }) =>
    document.offsetAt({ line: pos.line, character: pos.column })
  const visit = (node: ParserNode) => {
    if (
      node.type === 'statement' &&
      /^(datalines|cards|lines|parmcards)4?$/i.test(node.name ?? '')
    ) {
      const raw = node.children?.[0]
      if (raw?.type === 'raw-data' && raw.start && raw.text) {
        const match = /^\s*(datalines|cards|lines|parmcards)4?\b/i.exec(raw.text)
        if (match) {
          const word = match[0].trimStart()
          const start = raw.start.column + match[0].length - word.length
          cardsOpeners.push({ line: raw.start.line, start, end: start + word.length })
        }
      }
    }
    if (node.type === 'raw-data' && node.start && node.end) {
      protectedSpans.push({ start: offset(node.start), end: offset(node.end) })
    }
    node.children?.forEach(visit)
  }
  visit(getParser(model, parserTokens, syntaxProvider)())

  return text
    .split('\n')
    .map((line, index) => {
      const tokens = syntaxProvider.getSyntax(index) ?? []
      let result = line
      for (let at = tokens.length - 1; at >= 0; at--) {
        const token = tokens[at]
        if (!KEYWORD_STYLES.has(token.style)) continue
        const end = at === tokens.length - 1 ? line.length : tokens[at + 1].start
        const startOffset = document.offsetAt({ line: index, character: token.start })
        const endOffset = document.offsetAt({ line: index, character: end })
        if (protectedSpans.some((span) => startOffset < span.end && endOffset > span.start))
          continue
        const word = line.slice(token.start, end)
        if (!/[A-Za-z]/.test(word)) continue
        result = result.slice(0, token.start) + transform(word) + result.slice(end)
      }
      for (const opener of cardsOpeners.filter((item) => item.line === index)) {
        result =
          result.slice(0, opener.start) +
          transform(result.slice(opener.start, opener.end)) +
          result.slice(opener.end)
      }
      return result
    })
    .join('\n')
}
