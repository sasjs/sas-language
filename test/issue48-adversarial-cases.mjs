import assert from 'node:assert/strict'

// Deterministic adversarial matrix: record-looking code must remain record text.
export async function checkUnsafeSuffix(formatText) {
  const masks = [
    '%bquote(%()',
    '%nrbquote(%))',
    "%bquote('x%(y')",
    '%bquote(%str(%())',
    '%bquote(before %nrstr(%)) after)',
    '%bquote(%str(%(%)))'
  ]
  const cards = [
    'datalines',
    'cards',
    'lines',
    'datalines4',
    'cards4',
    'lines4',
    'parmcards',
    'parmcards4'
  ]
  const records = [
    'run;   DATA',
    'DATA x;  PROC PRINT;',
    "a 'quoted'   b",
    '  ;;; indented text',
    '  %PUT X;'
  ]
  let count = 0
  for (const eol of ['\n', '\r\n']) {
    for (const mask of masks) {
      for (const opener of cards) {
        for (const record of records) {
          const end = opener.endsWith('4') ? ';;;;' : ';'
          const suffix = ['data w;', 'input x $;', `${opener};`, record, end, 'run;', '', ''].join(
            eol
          )
          const input = `%let z=${mask};${eol}${suffix}`
          for (const keywordCase of ['preserve', 'upper', 'lower']) {
            const output = await formatText(input, { keywordCase })
            const expectedSuffix = eol === '\r\n' ? suffix.slice(0, -2) + '\n' : suffix
            if (masks.indexOf(mask) < 3) {
              assert.ok(
                output.endsWith(eol + expectedSuffix),
                `${keywordCase}: ${JSON.stringify(input)} => ${JSON.stringify(output)}`
              )
            } else {
              assert.ok(
                output.includes(`${eol}${record}${eol}${end}`),
                `${keywordCase}: ${JSON.stringify(input)} => ${JSON.stringify(output)}`
              )
            }
            assert.equal(await formatText(output, { keywordCase }), output)
            count++
          }
        }
      }
    }
  }
  return count
}
