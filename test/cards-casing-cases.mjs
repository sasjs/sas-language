import assert from 'node:assert/strict'

export async function checkCardsCasing(formatText) {
  for (const keyword of [
    'datalines',
    'cards',
    'lines',
    'parmcards',
    'datalines4',
    'cards4',
    'lines4',
    'parmcards4'
  ]) {
    for (const mode of ['upper', 'lower']) {
      for (const eol of ['\n', '\r\n']) {
        for (const comment of ['', ' /* Keep DATA */']) {
          for (const terminated of [true, false]) {
            const opener = mode === 'upper' ? keyword : keyword.toUpperCase()
            const expectedOpener = mode === 'upper' ? keyword.toUpperCase() : keyword
            const data = ['run;', 'data test;', '  MiXeD   VALUE', '  ;;;;'].join(eol)
            const terminator = keyword.endsWith('4') ? ';;;;' : ';'
            const section = `${opener}${comment};${eol}${data}${terminated ? eol + terminator : ''}`
            const prefix = mode === 'upper' ? 'data x; input x $;' : 'DATA x; INPUT x $;'
            const suffix = terminated
              ? eol + (mode === 'upper' ? 'proc print; run;' : 'PROC PRINT; RUN;') + eol
              : eol + eol
            const input = prefix + eol + section + suffix
            const output = await formatText(input, { keywordCase: mode })
            const expected = `${expectedOpener}${comment};${eol}${data}${terminated ? eol + terminator : ''}`
            const label = JSON.stringify({ keyword, mode, eol, comment, terminated })
            assert.ok(output.includes(expected), label + ': ' + JSON.stringify(output))
            assert.match(output, mode === 'upper' ? /DATA x;/ : /data x;/, label)
            if (terminated)
              assert.match(output, mode === 'upper' ? /PROC PRINT;/ : /proc print;/, label)
            assert.equal(await formatText(output, { keywordCase: mode }), output, label)
          }
        }
      }
    }
  }
  for (const keyword of [
    'datalines',
    'cards',
    'lines',
    'parmcards',
    'datalines4',
    'cards4',
    'lines4',
    'parmcards4'
  ]) {
    for (const mode of ['upper', 'lower']) {
      for (const eol of ['\n', '\r\n']) {
        for (const bad of ['"unterminated', '/* unterminated']) {
          const terminator = keyword.endsWith('4') ? ';;;;' : ';'
          const suffix = '%let x="DATA; PROC PRINT;";'
          const input = [
            'data x; input x $;',
            `${keyword} /* keep */;`,
            bad,
            terminator,
            suffix,
            ''
          ].join(eol)
          const baseline = await formatText(input)
          const output = await formatText(input, { keywordCase: mode })
          const label = JSON.stringify({ keyword, mode, eol, bad })
          assert.ok(
            output.includes([bad, terminator].join(eol)),
            label + ': ' + JSON.stringify(output)
          )
          assert.ok(output.includes('"DATA; PROC PRINT;"'), label + ': ' + JSON.stringify(output))
          if (baseline.includes([bad, terminator, suffix].join(eol))) {
            assert.ok(
              output.includes([bad, terminator, suffix].join(eol)),
              label + ': ' + JSON.stringify(output)
            )
          }
          assert.equal(await formatText(output, { keywordCase: mode }), output, label)
        }
      }
    }
  }
}
