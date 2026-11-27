import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatText } from '../dist/format.bundle.js'

for (const keywordCase of ['upper', 'lower']) {
  test(`ordinary masks and comments retain keyword casing: ${keywordCase}`, async () => {
    const source = keywordCase === 'upper' ? '%let' : '%LET'
    const expected = keywordCase === 'upper' ? '%LET' : '%let'
    for (const fragment of ['%str(&a)', '%str(a,b)', '/* %str(a,b) */']) {
      const input = `${source} x=${fragment};\n${source} y=1;\n`
      const output = await formatText(input, { keywordCase })
      assert.ok(output.startsWith(expected), JSON.stringify(output))
      assert.ok(output.includes(`${expected} y=1;`), JSON.stringify(output))
      assert.equal(await formatText(output, { keywordCase }), output)
    }
  })
  test(`cards records are not cased: ${keywordCase}`, async () => {
    const records = keywordCase === 'upper' ? 'run;\ndata test;' : 'RUN;\nDATA TEST;'
    const input = `data x; input x $; datalines;\n${records}\n;\nrun;\n`
    const output = await formatText(input, { keywordCase })
    assert.ok(output.includes(`\n${records}\n;\n`), JSON.stringify(output))
    // Layout of a same-line opener is a separate parser issue (#43).
  })
  test(`unsafe fallback protects literals but cases the prefix: ${keywordCase}`, async () => {
    const prefix = keywordCase === 'upper' ? '%let' : '%LET'
    const wanted = keywordCase === 'upper' ? '%LET' : '%let'
    const literal =
      keywordCase === 'upper' ? "'begin; proc print; end'" : "'BEGIN; PROC PRINT; END'"
    const input = `${prefix} before=1;\n%let x=%str('%');\ndata a; x=${literal}; run;\n`
    const output = await formatText(input, { keywordCase })
    assert.ok(output.startsWith(wanted), JSON.stringify(output))
    assert.ok(output.includes(`x=${literal}`), JSON.stringify(output))
    assert.equal(await formatText(output, { keywordCase }), output)
  })
}
