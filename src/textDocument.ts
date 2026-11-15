/**
 * The text buffer the formatter's model reads, and the edits it hands back.
 *
 * Upstream wraps `vscode-languageserver-textdocument` for this, which would mean
 * carrying that package into the published bundle for four methods. Positions
 * here follow the same rules: `offsetAt` clamps to the end of the line's content,
 * so a range ending at `character: 0` of the next line includes the newline -
 * which is exactly how `Model.getLine` reads a line back.
 *
 * There is no editor in the picture, so a "document" here is a string plus the
 * arithmetic to slice it. Keeping that in its own module is what makes the edit
 * application testable without the language core: `applyEdits` is pure, and the
 * suite exercises it directly rather than inferring it from formatted output.
 */
export interface TextPosition {
  line: number
  character: number
}

export interface TextRange {
  start: TextPosition
  end: TextPosition
}

export interface TextEdit {
  range: TextRange
  newText: string
}

export interface TextDocumentLike {
  getText(range: TextRange): string
  lineCount: number
  offsetAt(position: TextPosition): number
}

export const documentFrom = (text: string): TextDocumentLike => {
  const lines = text.split(/\r\n|\r|\n/)
  const starts: number[] = []
  const lengths: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    lengths.push(line.length)
    offset += line.length
    // A line break of any spelling advances the next line by the same amount;
    // only the content lengths matter for clamping.
    const rest = text.slice(offset)
    const lineBreak = /^(?:\r\n|\r|\n)/.exec(rest)
    if (lineBreak) offset += lineBreak[0].length
  }

  const offsetAt = ({ line, character }: TextPosition) => {
    if (line >= starts.length) return text.length
    return Math.min(starts[line] + character, starts[line] + lengths[line])
  }

  return {
    lineCount: lines.length,
    offsetAt,
    getText: (range) => text.slice(offsetAt(range.start), offsetAt(range.end))
  }
}

/**
 * Applies every edit the formatter returned, in one pass of the original text.
 *
 * The server's own formatter returns a single whole-document edit, and if
 * upstream ever returned several, taking `edits[0]` would hand back a partly
 * formatted buffer with nothing said about it. Applying from the end backwards
 * is the order that keeps each edit's offsets valid - an earlier edit cannot move
 * a later one out from under it, because the later ones are applied first.
 */
export const applyEdits = (text: string, edits: TextEdit[]): string => {
  if (!edits.length) return text

  const document = documentFrom(text)
  const ordered = edits
    .map((edit) => ({
      start: document.offsetAt(edit.range.start),
      end: document.offsetAt(edit.range.end),
      newText: edit.newText
    }))
    .sort((a, b) => b.start - a.start || b.end - a.end)

  return ordered.reduce(
    (result, edit) => result.slice(0, edit.start) + edit.newText + result.slice(edit.end),
    text
  )
}
