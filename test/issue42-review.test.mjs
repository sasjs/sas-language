import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

const bundle = new URL('../dist/format.bundle.js', import.meta.url)
const data = new URL('../server/node/pubsdata/procedures.json', import.meta.url)
const reason = !existsSync(bundle)
  ? 'dist/format.bundle.js is not built: run npm run build:format'
  : !existsSync(data)
    ? 'no staged language data: run npm run build:server'
    : undefined
const { formatText } = reason ? {} : await import(bundle.href)
const run = (name, fn) => test(name, { skip: reason }, fn)

for (const keywordCase of ['preserve', 'upper', 'lower']) {
  run(`mask quote cannot corrupt later literals: ${keywordCase}`, async () => {
    for (const literal of ["'begin; proc print; end'", "'BEGIN; PROC PRINT; END'"]) {
      const input = `%let x=%str('%');\ndata a; x=${literal}; run;\n`
      const output = await formatText(input, { keywordCase })
      assert.ok(output.includes(`x=${literal}`), JSON.stringify(output))
      assert.equal(await formatText(output, { keywordCase }), output)
    }
  })
  run(`mask ending at EOF is retained exactly: ${keywordCase}`, async () => {
    for (const input of ["%put %str('%')", "%put %nrstr(a; %str('%'); b)"]) {
      const output = await formatText(input, { keywordCase })
      assert.equal(output, input + '\n')
      assert.equal(await formatText(output, { keywordCase }), output)
    }
  })
  run(`truncated masks retain all text: ${keywordCase}`, async () => {
    for (const input of [
      '%let x=%nrstr(foo\n%put TAIL;\n\n\n',
      "%let x=%str('%');\n%put %nrstr(a;\n\n"
    ]) {
      assert.equal(await formatText(input, { keywordCase }), input)
    }
  })
}

run('ordinary masks retain layout and requested keyword case', async () => {
  const input = '%let x = %str(ordinary);\n%put tail;\n'
  for (const [keywordCase, expected] of [
    ['preserve', '%let x=%str(ordinary);\n%put tail;\n'],
    ['upper', '%LET x=%STR(ordinary);\n%PUT tail;\n'],
    ['lower', '%let x=%str(ordinary);\n%put tail;\n']
  ])
    assert.equal(await formatText(input, { keywordCase }), expected)
})
