/**
 * Guards the document arithmetic and the edit application, on their own.
 *
 * These two functions are the part of the formatter that can be checked without
 * the language core: no data, no lexer, no build artifact beyond `tsc`'s output.
 * That matters because the case worth protecting - a result with several edits -
 * cannot be produced by the formatter as it stands (it returns one whole-document
 * edit), so a test that went through `formatText` could not reach it at all.
 *
 * `dist/textDocument.js` is imported directly rather than through the export map:
 * it is a module of the package, not one of its entry points, and it needs only
 * `npm run build:ts`.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MODULE = path.join(ROOT, 'dist', 'textDocument.js')

const reason = existsSync(MODULE)
  ? undefined
  : 'dist/textDocument.js is not built: run npm run build:ts'
const { applyEdits, documentFrom } = reason ? {} : await import('file://' + MODULE)

const run = (name, fn) =>
  test(name, async (context) => {
    if (reason) return context.skip(reason)
    await fn()
  })

const at = (line, character) => ({ line, character })

run('a line is read back with its line break, as Model.getLine expects', () => {
  const document = documentFrom('data foo;\nrun;\n')
  assert.equal(document.lineCount, 3)
  assert.equal(document.getText({ start: at(0, 0), end: at(1, 0) }), 'data foo;\n')
  assert.equal(document.getText({ start: at(1, 0), end: at(2, 0) }), 'run;\n')
})

run('offsetAt clamps to the end of a line and past the end of the text', () => {
  const document = documentFrom('data foo;\nrun;\n')
  assert.equal(document.offsetAt(at(0, 4)), 4)
  assert.equal(document.offsetAt(at(0, 99)), 9) // the line's content, before the break
  assert.equal(document.offsetAt(at(2, 0)), 15) // the empty last line reads as the end
  assert.equal(document.offsetAt(at(9, 0)), 15)
})

run('CRLF windows are counted as one break, not two', () => {
  const document = documentFrom('data foo;\r\nrun;\r\n')
  assert.equal(document.lineCount, 3)
  assert.equal(document.offsetAt(at(1, 0)), 11)
  assert.equal(document.getText({ start: at(0, 0), end: at(1, 0) }), 'data foo;\r\n')
})

run('no edits leaves the text alone', () => {
  assert.equal(applyEdits('data foo;\n', []), 'data foo;\n')
})

run('a whole-document edit replaces everything', () => {
  const edited = applyEdits('data foo;\n', [
    { range: { start: at(0, 0), end: at(1, 0) }, newText: 'data foo;\n  set bar;\n' }
  ])
  assert.equal(edited, 'data foo;\n  set bar;\n')
})

run('several edits are all applied, not just the first', () => {
  // Two lines of the same file, edited out of order in the list: applying them
  // front to back would move the second range, which is the truncation this
  // guards against.
  const text = 'data foo;\nset bar;\nrun;\n'
  const edited = applyEdits(text, [
    { range: { start: at(1, 0), end: at(1, 3) }, newText: '  set' },
    { range: { start: at(0, 0), end: at(0, 4) }, newText: 'DATA' }
  ])
  assert.equal(edited, 'DATA foo;\n  set bar;\nrun;\n')
})
