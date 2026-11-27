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

for (const [keywordCase, input, expected] of [
  [
    'upper',
    '%let x=%nrstr(%put hello;);\n%put tail;\n',
    '%LET x=%NRSTR(%put hello;);\n%PUT tail;\n'
  ],
  [
    'lower',
    '%LET x=%NRSTR(%PUT HELLO;);\n%PUT TAIL;\n',
    '%let x=%nrstr(%PUT HELLO;);\n%put TAIL;\n'
  ]
]) {
  run(`casing preserves masked keyword text: ${keywordCase}`, async () => {
    const output = await formatText(input, { keywordCase })
    assert.equal(output, expected)
    assert.equal(await formatText(output, { keywordCase }), output)
  })
}

run('quote functions preserve argument bytes and case ordinary code outside', async () => {
  for (const name of ['str', 'nrstr', 'quote', 'nrquote', 'bquote', 'nrbquote', 'superq']) {
    const argument = `%put hello;`
    const source = `%let x=%${name}(${argument});\n%put tail;\n`
    for (const keywordCase of ['upper', 'lower']) {
      const output = await formatText(source, { keywordCase })
      assert.ok(output.includes(`(${argument})`), JSON.stringify([name, output]))
      assert.ok(output.includes(keywordCase === 'upper' ? '%PUT tail;' : '%put tail;'))
      assert.equal(await formatText(output, { keywordCase }), output)
    }
  }
})

run('masked quote and parenthesis tokens remain unchanged', async () => {
  for (const name of ['str', 'nrstr', 'quote', 'nrquote']) {
    const argument = `%put hello; %" %' %(`
    const source = `%let x=%${name}(${argument});\n%put tail;\n`
    const output = await formatText(source, { keywordCase: 'upper' })
    assert.ok(output.includes(`(${argument})`), JSON.stringify(output))
    assert.ok(output.includes('%PUT tail;'))
  }
})

run(
  'nested multiline masks preserve their exact argument and resume casing afterwards',
  async () => {
    for (const eol of ['\n', '\r\n']) {
      for (const keywordCase of ['upper', 'lower']) {
        const argument = `abc %str(%put inner;)${eol} %put next; /* ) */ %' x`
        const source = `%let x=%nrstr(${argument});${eol}%put tail;${eol}`
        const output = await formatText(source, { keywordCase })
        assert.ok(output.includes(argument), JSON.stringify(output))
        assert.ok(output.includes(keywordCase === 'upper' ? '%PUT tail;' : '%put tail;'))
        assert.equal(await formatText(output, { keywordCase }), output)
      }
    }
  }
)

run('unsafe fallback protects the full suffix while casing the prefix', async () => {
  const suffix = "%let x=%str('%');\ndata a; x='begin; proc print; end'; run;\n"
  const output = await formatText('%let before=1;\n' + suffix, { keywordCase: 'upper' })
  assert.equal(output, '%LET before=1;\n' + suffix)
  assert.equal(await formatText(output, { keywordCase: 'upper' }), output)
})

test(
  'casing handles a flat AST with 140000 statements',
  { timeout: 120000, skip: reason },
  async () => {
    const input = '%put hello;\n'.repeat(140000)
    const output = await formatText(input, { keywordCase: 'upper' })
    assert.equal(output, '%PUT hello;\n'.repeat(140000))
  }
)
