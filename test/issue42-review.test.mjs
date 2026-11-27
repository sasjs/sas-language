import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatText } from '../dist/format.bundle.js'

for (const keywordCase of ['preserve', 'upper', 'lower']) {
  test(`mask quote cannot corrupt later literals: ${keywordCase}`, async () => {
    for (const literal of ["'begin; proc print; end'", "'BEGIN; PROC PRINT; END'"]) {
      const input = `%let x=%str('%');\ndata a; x=${literal}; run;\n`
      const output = await formatText(input, { keywordCase })
      assert.ok(output.includes(`x=${literal}`), JSON.stringify(output))
      assert.equal(await formatText(output, { keywordCase }), output)
    }
  })
  test(`mask ending at EOF is retained exactly: ${keywordCase}`, async () => {
    for (const input of ["%put %str('%')", "%put %nrstr(a; %str('%'); b)"]) {
      const output = await formatText(input, { keywordCase })
      assert.equal(output, input + '\n')
      assert.equal(await formatText(output, { keywordCase }), output)
    }
  })
  test(`truncated masks retain all text: ${keywordCase}`, async () => {
    for (const input of [
      '%let x=%nrstr(foo\n%put TAIL;\n\n\n',
      "%let x=%str('%');\n%put %nrstr(a;\n\n"
    ]) {
      assert.equal(await formatText(input, { keywordCase }), input)
    }
  })
}

test('ordinary masks retain layout and requested keyword case', async () => {
  const input = '%let x = %str(ordinary);\n%put tail;\n'
  for (const [keywordCase, expected] of [
    ['preserve', '%let x=%str(ordinary);\n%put tail;\n'],
    ['upper', '%LET x=%STR(ordinary);\n%PUT tail;\n'],
    ['lower', '%let x=%str(ordinary);\n%put tail;\n']
  ])
    assert.equal(await formatText(input, { keywordCase }), expected)
})
