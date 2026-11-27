/**
 * Guards the `formatText` entry point: the published `./format` import, the
 * behaviour a caller depends on, and the failure mode when the vocabulary is
 * absent.
 *
 * Two build artifacts have to exist for any of this to run - `dist/format.bundle.js`,
 * which `build:format` bundles from the upstream core, and the staged
 * `server/node` tree, which holds the language data the formatter lexes with.
 * Both belong to the server job: it is the only job that fetches the upstream
 * source the bundle is compiled from, and the only one that stages the data. So a
 * missing artifact here is a skip with the reason printed rather than a failure,
 * the same shape as `server.test.mjs`.
 *
 * The expected output is spelled out rather than "differs from input": these
 * strings are what the printer produces, and a silent change in how it indents
 * or where it breaks a statement is exactly what a reader of this file needs to
 * see fail.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = path.join(ROOT, 'dist', 'format.bundle.js')
const DATA_ROOT = path.join(ROOT, 'server', 'node')

const skip = async () => {
  if (!existsSync(BUNDLE)) return 'dist/format.bundle.js is not built: run npm run build:format'
  if (!existsSync(path.join(DATA_ROOT, 'pubsdata', 'procedures.json'))) {
    return 'no staged language data: run npm run build:server'
  }
  return undefined
}

const reason = await skip()
const { formatText, defaultDataRoot } = reason ? {} : await import('file://' + BUNDLE)

const run = (name, fn, options = {}) =>
  test(name, options, async (context) => {
    if (reason) return context.skip(reason)
    await fn()
  })

run('indented PARMCARDS4 semicolons remain records until column-one terminator', async () => {
  const input = 'filename f temp;\nparmcards4;\nalpha\n  ;;;;\n  x   y\n;;;;\n%put TAIL;\n'
  const output = await formatText(input)
  assert.ok(output.includes('\nalpha\n  ;;;;\n  x   y\n;;;;\n'), output)
  assert.ok(output.includes('%put TAIL;'), output)
  assert.equal(await formatText(output), output)
})

run(
  'PARMCARDS4 preserves indented records with mixed line endings and incomplete input',
  async () => {
    for (const mode of ['preserve', 'upper', 'lower']) {
      for (const terminated of [true, false]) {
        const records = 'alpha\r\n  ;;;;\n  x   y\r\n\t;;;;\nrun; data test;'
        const ending = terminated ? '\r\n;;;;\n%put tail;\n' : '\r\n\r\n'
        const input = `parmcards4;\n${records}${ending}`
        const output = await formatText(input, { keywordCase: mode })
        assert.ok(output.includes(records), JSON.stringify({ mode, terminated, output }))
        if (terminated) assert.match(output, /;;;;\n%(?:put|PUT) tail;/)
        else assert.ok(output.endsWith('\r\n\n'), JSON.stringify(output))
        assert.equal(await formatText(output, { keywordCase: mode }), output)
      }
    }
  }
)

run('mask boundary fallback preserves prefixes, regions, comments and later tokens', async () => {
  const cases = [
    { input: "%let x=%str('%');\n%put TAILMARKER;\n" },
    {
      input: "data x; a=1; %let x=%str('%'); b=2; run;\n%put TAIL;\n",
      expected: "data x;\n  a=1;\n%let x=%str('%'); b=2; run;\n%put TAIL;\n"
    },
    {
      input: "%let x=%str('%');\n%put TAIL;\n%put 'later';\n%put END;\n"
    },
    {
      input:
        "%macro m;\n  %if 1 %then %do;\n    %let x=%str('%');\n    %put TAIL;\n  %end;\n%mend;\n"
    },
    { input: "%let x=\n   %str('%');\n%put TAIL;\n" },
    { input: "/* before */\n%let x=%str('%'); /* after */ %put TAIL;\n" },
    { input: '%let x=%nrstr("abc%");\n%put TAIL;\n' },
    { input: "%let x=%str((a) /* ) */ '%');\n%put TAIL;\n" },
    { input: "%let x=%str('%'); data a; run;\n" }
  ]
  for (const { input, expected = input } of cases) {
    const output = await formatText(input)
    assert.equal(output, expected, input)
    assert.equal(await formatText(output), output, `second pass: ${input}`)
  }
})

run('mask fallback retains LF and CRLF blank records and adds only the final newline', async () => {
  for (const input of [
    "%let x=%str('%');\n%put TAIL;\n\n\n",
    "%let x=%str('%');\r\n%put TAIL;\r\n\r\n\r\n",
    '%let x=%nrstr(foo\n%put TAIL;\n\n\n',
    '%let x=%nrstr(foo\r\n%put TAIL;\r\n\r\n\r\n',
    "%let x=%str('%');"
  ]) {
    // The formatter normally emits LF for the final line break, even for CRLF.
    const expected = input.endsWith('\r\n')
      ? input.slice(0, -2) + '\n'
      : input.endsWith('\n')
        ? input
        : input + '\n'
    const output = await formatText(input)
    assert.equal(output, expected, JSON.stringify(input))
    assert.equal(await formatText(output), output)
  }
})

run('mask fallback remains safe with keywordCase options', async () => {
  const input = "%let x=%str('%');\n%put tailmarker;\n"
  for (const [keywordCase, expected] of [
    ['preserve', input],
    ['upper', input],
    ['lower', input]
  ]) {
    const output = await formatText(input, { keywordCase })
    assert.equal(output, expected, keywordCase)
    assert.equal(await formatText(output, { keywordCase }), output)
  }
})

run('macro comments in masks cannot swallow the following statement', async () => {
  for (const input of [
    '%let x=%str(%* ) ; hello);\n%put TAIL;\n',
    '%let x=%str(a; %* ) ; data z;);\n%put TAIL;\n'
  ]) {
    const output = await formatText(input)
    assert.equal(output.replace(/\s/g, ''), input.replace(/\s/g, ''))
    assert.equal(await formatText(output), output)
  }
})

run('ordinary masks continue to format outside the argument', async () => {
  const input = '%let x = %str(ordinary);\n%put TAIL;\n'
  const output = await formatText(input)
  assert.equal(output, '%let x=%str(ordinary);\n%put TAIL;\n')
  assert.equal(await formatText(output), output)
})

run('the default data root is the staged server tree', async () => {
  assert.equal(defaultDataRoot, DATA_ROOT)
})

run('a DATA step is indented and its if/else is split', async () => {
  const input = [
    'data work.foo;',
    'set sashelp.class;',
    'where sex="F";',
    'if age>12 then flag=1;else flag=0;',
    'run;',
    ''
  ].join('\n')

  const output = await formatText(input)

  assert.equal(
    output,
    [
      'data work.foo;',
      '  set sashelp.class;',
      '  where sex="F";',
      '  if age>12 then flag=1;',
      '  else flag=0;',
      'run;',
      ''
    ].join('\n')
  )
})

run('a PROC step is indented, which needs that procedure own data file', async () => {
  // The lexer loads `pubsdata/Procedures/en/<PROC>.json` on demand and, with
  // the procedure's file missing, prints nothing at all for the whole buffer -
  // so this case is the guard on the data root being complete rather than just
  // present.
  const input = [
    'proc means data=work.foo n mean std;',
    'var age;',
    'class flag;',
    'run;',
    ''
  ].join('\n')

  const output = await formatText(input)

  assert.equal(
    output,
    ['proc means data=work.foo n mean std;', '  var age;', '  class flag;', 'run;', ''].join('\n')
  )
})

run('keyword case is preserved, not normalised', async () => {
  // Upstream's printer has no casing option, and this is the test that keeps a
  // future reader from assuming otherwise: casing is the rules layer's job.
  const lowercase = await formatText(['data foo;', 'set bar;', 'run;', ''].join('\n'))
  assert.match(lowercase, /^data foo;\n {2}set bar;\nrun;\n$/)

  const uppercase = await formatText(['DATA foo;', 'SET bar;', 'RUN;', ''].join('\n'))
  assert.match(uppercase, /^DATA foo;\n {2}SET bar;\nRUN;\n$/)
})

run('macro function values do not swallow the closing do group', async () => {
  const input = [
    '%macro f();',
    '%if &type=N %then %do;',
    '&valn',
    '%end;',
    '%else %if &type=C %then %do;',
    '&valc',
    '%end;',
    '%mend f;',
    ''
  ].join('\n')
  const expected = [
    '%macro f();',
    '  %if &type=N %then %do;',
    '    &valn',
    '  %end;',
    '  %else %if &type=C %then %do;',
    '    &valc',
    '  %end;',
    '%mend f;',
    ''
  ].join('\n')
  const output = await formatText(input)
  assert.equal(output, expected)
  assert.equal(await formatText(output), output)
})

run('macro function result is separated from its closing end', async () => {
  const input = ['%macro f();', '%if 1 %then %do;', '%upcase(&x)', '%end;', '%mend f;', ''].join(
    '\n'
  )
  const output = await formatText(input)
  assert.equal(
    output,
    ['%macro f();', '  %if 1 %then %do;', '    %upcase(&x)', '  %end;', '%mend f;', ''].join('\n')
  )
})

run('adjacent macro text and end do not gain a space', async () => {
  const input = ['%macro f();', '%do;', 'abc%end;', '%mend f;', ''].join('\n')
  const output = await formatText(input)
  assert.equal(output, '%macro f();\n  %do;\n  abc%end;\n%mend f;\n')
  assert.equal(await formatText(output), output)
})

run('macro end inside an unfinished call is not split from its argument', async () => {
  const input = ['%macro f();', '%do;', '%other(a=foo %end; bar)', '%end;', '%mend f;', ''].join(
    '\n'
  )
  const output = await formatText(input)
  assert.equal(output, '%macro f();\n  %do;\n  %other(a=foo %end;\n  bar) %end;\n%mend f;\n')
  assert.equal(await formatText(output), output)
})

run('nested macro do blocks align their closing keywords', async () => {
  const input = ['%macro f();', '%do;', '%do;', '&value', '%end;', '%end;', '%mend f;', ''].join(
    '\n'
  )
  const output = await formatText(input)
  assert.equal(
    output,
    [
      '%macro f();',
      '  %do;',
      '    %do;',
      '      &value',
      '    %end;',
      '  %end;',
      '%mend f;',
      ''
    ].join('\n')
  )
  assert.equal(await formatText(output), output)
})

run('quoted end is not a macro do boundary', async () => {
  const input = [
    '%macro f();',
    '%do;',
    '%let v=%nrstr(%end;);',
    '&v',
    '%end;',
    '%mend f;',
    ''
  ].join('\n')
  const output = await formatText(input)
  assert.equal(
    output,
    [
      '%macro f();',
      '  %do;',
      '    %let v=%nrstr(%end;);',
      '    &v',
      '  %end;',
      '%mend f;',
      ''
    ].join('\n')
  )
  assert.equal(await formatText(output), output)
})

run('formatting is idempotent', async () => {
  const input = [
    'data work.foo;',
    'set sashelp.class;',
    'if age>12 then flag=1;else flag=0;',
    'run;',
    ''
  ].join('\n')
  const once = await formatText(input)
  // Asserting that the first pass changed something is the point of the test: a
  // formatter that returns its input untouched is trivially idempotent, and
  // without this line the two assertions below would hold for it too.
  assert.notEqual(once, input)
  const twice = await formatText(once)
  assert.equal(twice, once)
})

run('tabWidth is honoured, not just accepted', async () => {
  // `tabWidth` and `useTabs` are prettier's names and the printer reads them;
  // this asserts the width as well as the tab character, because a declaration
  // that let any option through would accept both and prove neither.
  const input = ['data foo;', 'set bar;', 'run;', ''].join('\n')

  assert.equal((await formatText(input, { tabWidth: 2 })).split('\n')[1], '  set bar;')
  assert.equal((await formatText(input, { tabWidth: 4 })).split('\n')[1], '    set bar;')
  assert.equal((await formatText(input, { tabWidth: 8 })).split('\n')[1], '        set bar;')
})

run('tabs are used when they are asked for', async () => {
  // The option is prettier's `useTabs`, not the LSP's `insertSpaces`: an editor
  // passes the latter and the host maps it, which is why this is asserted here -
  // the printer ignores a name it does not know and indents with spaces.
  const output = await formatText(['data foo;', 'set bar;', 'run;', ''].join('\n'), {
    useTabs: true
  })
  assert.match(output, /^data foo;\n\tset bar;\nrun;\n$/)
})

run('keyword case is applied when it is asked for', async () => {
  // The words come from the lexer's own token table, not from a list of statement
  // names: ELSE, THEN and a procedure's statements (VAR, CLASS) are not in the
  // statement files, and a vocabulary-based pass left them untouched beside cased
  // neighbours.
  const input = [
    'DATA work.foo;',
    'SET sashelp.class;',
    'IF age>12 THEN flag=1;ELSE flag=0;',
    'RUN;',
    '',
    'PROC MEANS data=work.foo n mean;',
    'VAR age;',
    'CLASS flag;',
    'RUN;',
    ''
  ].join('\n')

  const lowered = await formatText(input, { keywordCase: 'lower' })
  assert.equal(
    lowered,
    [
      'data work.foo;',
      '  set sashelp.class;',
      '  if age>12 then flag=1;',
      '  else flag=0;',
      'run;',
      '',
      'proc means data=work.foo n mean;',
      '  var age;',
      '  class flag;',
      'run;',
      ''
    ].join('\n')
  )

  const raised = await formatText(
    ['data foo;', 'set bar;', 'if x then y=1;else y=0;', 'run;', ''].join('\n'),
    { keywordCase: 'upper' }
  )
  assert.equal(
    raised,
    ['DATA foo;', '  SET bar;', '  IF x THEN y=1;', '  ELSE y=0;', 'RUN;', ''].join('\n')
  )
})

run('keyword case leaves strings, comments and identifiers alone', async () => {
  const input = [
    'data foo;',
    '/* data step, kept as written */',
    'note = "DATA step in a string";',
    'keep total;',
    'run;',
    ''
  ].join('\n')

  const output = await formatText(input, { keywordCase: 'upper' })

  assert.match(output, /DATA foo;/)
  assert.match(output, /\/\* data step, kept as written \*\//)
  assert.match(output, /"DATA step in a string"/)
  // KEEP is a statement, `total` is a name: one is cased, the other is not.
  assert.match(output, /KEEP total;/)
})

run('keyword case does nothing unless it is asked for', async () => {
  const input = ['data foo;', 'set bar;', 'run;', ''].join('\n')
  assert.equal(await formatText(input, { keywordCase: 'preserve' }), await formatText(input))
})

run('a dataRoot belongs to its own call and is not left behind', async () => {
  // The loader's root is process-wide state, so this is the case that keeps a
  // caller from pinning it: a second tree is used for one call, then deleted, and
  // the next call has to fall back to the default rather than fail on a root that
  // is no longer there. The rejected call after it covers the same leak when the
  // call throws - `assertDataRoot` runs inside the window the root is set in.
  const isolated = await mkdtemp(path.join(tmpdir(), 'sasjs-format-'))
  await symlink(path.join(DATA_ROOT, 'pubsdata'), path.join(isolated, 'pubsdata'))
  await symlink(path.join(DATA_ROOT, 'data'), path.join(isolated, 'data'))

  const input = ['data foo;', 'set bar;', 'run;', ''].join('\n')
  const expected = 'data foo;\n  set bar;\nrun;\n'

  assert.equal(await formatText(input, { dataRoot: isolated }), expected)

  await rm(isolated, { recursive: true, force: true })
  await assert.rejects(
    () => formatText(input, { dataRoot: isolated }),
    /SAS language data is missing/
  )

  // Back to the default: if the previous call had pinned its root, this throws.
  assert.equal(await formatText(input), expected)
})

run('two calls started together each see their own root', async () => {
  // The roots have to differ in a way the output shows, so the second tree has no
  // procedure files: from it a PROC step throws, from the default root it
  // formats. Started together, both outcomes have to survive - a root shared
  // between them would turn one of these into the other.
  //
  // Lexing runs inside the call that set the root rather than after an await,
  // which is why `Promise.all` here is not the test of a queue: there is no
  // queue, and this asserts the property the queue was standing in for.
  const crippled = await mkdtemp(path.join(tmpdir(), 'sasjs-format-noproc-'))
  await mkdir(path.join(crippled, 'pubsdata'), { recursive: true })
  for (const entry of ['Statements', 'Functions', 'procedures.json']) {
    await symlink(path.join(DATA_ROOT, 'pubsdata', entry), path.join(crippled, 'pubsdata', entry))
  }
  await symlink(path.join(DATA_ROOT, 'data'), path.join(crippled, 'data'))

  // An unused procedure, so the process-wide cache cannot already hold its data.
  const input = ['proc printto log=\"/tmp/x.log\";', 'run;', ''].join('\n')
  const formatted = 'proc printto log=\"/tmp/x.log\";\nrun;\n'

  const [crippledCall, defaultCall] = await Promise.allSettled([
    formatText(input, { dataRoot: crippled }),
    formatText(input)
  ])

  assert.equal(crippledCall.status, 'rejected', 'the tree without the procedure file must fail')
  assert.match(String(crippledCall.reason?.message), /PRINTTO\.json/)
  assert.equal(defaultCall.status, 'fulfilled')
  assert.equal(defaultCall.value, formatted)

  await rm(crippled, { recursive: true, force: true })
})

run('an otherwise complete root missing one procedure file rejects', async () => {
  // The tree here is the real one with a single symlink left out, which is the
  // case that settles a question the docs got wrong once: does a missing
  // procedure file throw, or come back as an unformatted buffer? It throws, and
  // the message names the file - the assertion is on that name rather than on
  // "some error", so a failure elsewhere cannot satisfy it.
  const root = await mkdtemp(path.join(tmpdir(), 'sasjs-format-oneproc-'))
  await mkdir(path.join(root, 'pubsdata', 'Procedures', 'en'), { recursive: true })
  for (const entry of ['Statements', 'Functions', 'procedures.json']) {
    await symlink(path.join(DATA_ROOT, 'pubsdata', entry), path.join(root, 'pubsdata', entry))
  }
  await symlink(path.join(DATA_ROOT, 'data'), path.join(root, 'data'))
  for (const file of await readdir(path.join(DATA_ROOT, 'pubsdata', 'Procedures', 'en'))) {
    if (file === 'SORT.json') continue
    await symlink(
      path.join(DATA_ROOT, 'pubsdata', 'Procedures', 'en', file),
      path.join(root, 'pubsdata', 'Procedures', 'en', file)
    )
  }

  const input = ['proc sort data=work.foo;', 'by age;', 'run;', ''].join('\n')
  await assert.rejects(() => formatText(input, { dataRoot: root }), /SORT\.json/)

  await rm(root, { recursive: true, force: true })
})

run('a missing data root fails with the path and the way out', async () => {
  // Deliberately not the last test in this file: the root is restored either way.
  await assert.rejects(
    () => formatText('data foo;\nrun;\n', { dataRoot: path.join(ROOT, 'no-such-tree') }),
    (error) => {
      assert.match(error.message, /SAS language data is missing/)
      assert.match(error.message, /no-such-tree/)
      assert.match(error.message, /dataRoot/)
      return true
    }
  )
})

run('standalone macro calls remain separate statements', async () => {
  const input = '%first(a=(1))\n\n%second(b=2)\n%let x=1;\n'
  const output = await formatText(input)
  assert.equal(output, input)
  assert.equal(await formatText(output), output)
})

run('a standalone call with a trailing comment stays separate', async () => {
  const input = '%first(a=1) /* why */\n%second(b=2)\n'
  const output = await formatText(input)
  assert.equal(output, input)
  assert.equal(await formatText(output), output)
})

run('a standalone call with a comment before its opening parenthesis stays separate', async () => {
  const input = '%first /* note */ (x=1)\n%second(x=2)\n'
  const output = await formatText(input)
  assert.equal(output, input)
  assert.equal(await formatText(output), output)
})

run('a call before mend ends at the surrounding macro indentation', async () => {
  const input = '%macro m();\n  %first(a=(1))\n%mend m;\n'
  assert.equal(await formatText(input), input)
})

run('a call inside a do block keeps the following statements indented', async () => {
  const input = [
    '%macro m();',
    '  %if 1 %then %do;',
    '    %first(x=1)',
    '    %let y=2;',
    '  %end;',
    '%mend m;',
    ''
  ].join('\n')
  assert.equal(await formatText(input), input)
})

run('a call with a semicolon or same-line expression is not split', async () => {
  for (const input of ['%foo(x=1);\n%let x=1;\n', '%foo(x=1) + %bar(y=2);\n']) {
    assert.equal(await formatText(input), input)
  }
})

run('a multiline expression beginning with a macro call stays together', async () => {
  const input = '%foo(x=1)\n+ %bar(y=2);\n'
  const output = await formatText(input)
  assert.equal(output, '%foo(x=1) + %bar(y=2);\n')
  assert.equal(output.replace(/\s/g, ''), input.replace(/\s/g, ''))
})

run('comments do not turn a call inside a larger expression into a statement', async () => {
  const input = '%let x=%first /* note */ (x=1)\n+ %second(x=2);\n'
  const output = await formatText(input)
  assert.equal(output.replace(/\s/g, ''), input.replace(/\s/g, ''))
  assert.doesNotMatch(output, /\)\s*\n\s*\+/)
})

run('a doxygen header keeps the layout of its body', async () => {
  // The upstream printer trims every line of a comment, and prettier then
  // re-indents each line to the enclosing statement, so an author's interior
  // layout had nowhere to survive. A header written the way @sasjs/core writes
  // one came back flush left - hanging continuations joined, and code samples
  // no longer indented far enough to be code in a doxygen reader.
  const header = [
    '/**',
    '  @file',
    '  @brief one line',
    '',
    '  Usage:',
    '',
    '      %let x=%mf_trim(&str);',
    '',
    '  @param [in] str described over',
    '    a hanging continuation',
    '',
    '  @version 9.2',
    '**/'
  ].join('\n')
  const input = `${header}\n%macro header_case();\n%mend header_case;\n`

  const output = await formatText(input)

  // Compared whole rather than line by line: a line joined to its neighbour
  // loses the paragraph break a doxygen reader needs, and that is the damage
  // this case exists to catch.
  assert.equal(output.split('\n').slice(0, header.split('\n').length).join('\n'), header)
  assert.equal(await formatText(output), output)
})

run('a comment keeps its indentation relative to the block it sits in', async () => {
  // Dedenting by the column the comment started at, rather than trimming each
  // line, is what keeps the offsets: the block indent still comes from the
  // printer and everything inside the comment is measured from it, which is why
  // the closing marker lands back on the comment's own column.
  const input = [
    '%macro comment_case();',
    '  %if 1 %then %do;',
    '    /**',
    '      @param [in] x described over',
    '        a hanging continuation',
    '',
    '          data x; set y; run;',
    '    **/',
    '    %put x;',
    '  %end;',
    '%mend comment_case;',
    ''
  ].join('\n')

  const output = await formatText(input)

  assert.match(
    output,
    /\n {4}\/\*\*\n {6}@param \[in\] x described over\n {8}a hanging continuation\n\n {10}data x; set y; run;\n {4}\*\*\/\n/
  )
})

run('a starred comment is left as it was written', async () => {
  // The star style puts a space before every marker, so the comment's own
  // indentation is not the closer's column - a patch that assumed it was would
  // shift the whole comment one space left on every run.
  const header = ['/**', ' * @brief star style', ' * @param [in] x', ' *   continued', ' */'].join(
    '\n'
  )
  const output = await formatText(`${header}\n%macro star_case();\n%mend star_case;\n`)

  assert.equal(output.split('\n').slice(0, 5).join('\n'), header)
  assert.equal(await formatText(output), output)
})

run('a starred comment nested in a block is left as it was written', async () => {
  // The only shape where the dedent and the star handling act together: at
  // column 0 the start column is 0, so the dedent cannot move a line and the
  // two cannot disagree. Nested, a line is shortened by the start column and
  // then re-indented by the printer, so the marker and the closer both land
  // back on the column the author wrote them at - or they do not, which is what
  // this asserts.
  const comment = ['    /**', '     * @brief x', '     * @param [in] y', '     */']
  const input = [
    '%macro nested_star();',
    '  %if 1 %then %do;',
    ...comment,
    '    %put x;',
    '  %end;',
    '%mend nested_star;',
    ''
  ].join('\n')

  const output = await formatText(input)
  const lines = output.split('\n')
  const start = lines.indexOf(comment[0])

  assert.notEqual(start, -1, 'the comment was moved or rewritten')
  assert.deepEqual(lines.slice(start, start + comment.length), comment)
  assert.equal(await formatText(output), output)
})

run('wrapped trailing block comments are indented consistently on the first pass', async () => {
  const comment = '/* a comment long enough that the line has to break somewhere here */'
  const options = { tabWidth: 2, useTabs: false, keywordCase: 'preserve' }
  const input = `data x;\n  if 1 then stop; ${comment}\nrun;\n`
  const expected = `data x;\n  if 1 then stop;\n  ${comment}\nrun;\n`

  const output = await formatText(input, options)
  assert.equal(output, expected)
  assert.equal(await formatText(output, options), output)
  assert.equal(await formatText(expected, options), expected)

  const short = 'data x;\n  if 1 then stop; /* short */\nrun;\n'
  assert.equal(await formatText(short, options), short)
})

run('wrapped comments at an implicit step boundary stay in the prior step', async () => {
  const comment =
    '/* an extremely long comment made longer than eighty characters by adding many extra words */'
  for (const [input, expected] of [
    [
      `proc sql;\nselect a from b; ${comment}\ndata x; run;\n`,
      `proc sql;\n  select a from b;\n  ${comment}\n\ndata x;\nrun;\n`
    ],
    [
      `data x;\nx=1; ${comment}\ndata y; run;\n`,
      `data x;\n  x=1;\n  ${comment}\n\ndata y;\nrun;\n`
    ],
    [
      `proc sql;\nselect a from b; ${comment}\nquit;\n`,
      `proc sql;\n  select a from b;\n  ${comment}\nquit;\n`
    ]
  ]) {
    const once = await formatText(input)
    assert.equal(once, expected)
    assert.equal(await formatText(once), expected)
  }
})

run('wrapped comment after a step terminator is stable before the next step', async () => {
  const comment =
    '/* an extremely long comment made longer than eighty characters by adding many extra words */'
  const input = `data x;\n  x=1;\nrun; ${comment}\ndata y;\nrun;\n`
  const expected = `data x;\n  x=1;\nrun;\n${comment}\n\ndata y;\nrun;\n`
  const output = await formatText(input)
  assert.equal(output, expected)
  assert.equal(await formatText(output), expected)
})

run('wrapped comments after PROC run and quit remain between steps', async () => {
  const comment =
    '/* an extremely long comment made longer than eighty characters by adding many extra words */'
  for (const [input, expected] of [
    [
      `proc print data=x; run; ${comment}\nproc means data=x; run;\n`,
      `proc print data=x;\nrun;\n${comment}\n\nproc means data=x;\nrun;\n`
    ],
    [
      `proc sql; select * from x; quit; ${comment}\ndata y; run;\n`,
      `proc sql;\n  select * from x;\nquit;\n${comment}\n\ndata y;\nrun;\n`
    ]
  ]) {
    const once = await formatText(input)
    assert.equal(once, expected)
    assert.equal(await formatText(once), expected)
  }
})

run('nested wrapped step comments keep their enclosing macro indentation', async () => {
  const comment =
    '/* an extremely long comment made longer than eighty characters by adding many extra words */'
  const input = `%macro m();\nproc sql; select * from x; quit; ${comment}\ndata y; run;\n%mend m;\n`
  const expected = `%macro m();\n  proc sql;\n    select * from x;\n  quit;\n  ${comment}\n\n  data y;\n  run;\n%mend m;\n`
  const once = await formatText(input)
  assert.equal(once, expected)
  assert.equal(await formatText(once), expected)
})

run('standalone step comments preserve surrounding blank line choices', async () => {
  for (const [input, expected] of [
    ['data x; run;\n/* note */\ndata y; run;\n', 'data x;\nrun;\n/* note */\n\ndata y;\nrun;\n'],
    ['data x; run;\n\n/* note */\ndata y; run;\n', 'data x;\nrun;\n\n/* note */\ndata y;\nrun;\n'],
    ['data x; run;\n/* note */\n\ndata y; run;\n', 'data x;\nrun;\n/* note */\n\ndata y;\nrun;\n'],
    ['data x; run; /* short */\ndata y; run;\n', 'data x;\nrun; /* short */\n\ndata y;\nrun;\n']
  ]) {
    const once = await formatText(input)
    assert.equal(once, expected)
    assert.equal(await formatText(once), expected)
  }
})

run('a comment after an ordinary statement ending in run remains a block header', async () => {
  const input = '%put run;\n/* header */\ndata y;\nrun;\n'
  const expected = '%put run;\n\n/* header */\ndata y;\nrun;\n'
  assert.equal(await formatText(input), expected)
  assert.equal(await formatText(expected), expected)
})

run('wrapped comments on region openers stay indented inside the region', async () => {
  const comment = '/* a comment long enough that the line has to break somewhere here */'
  const input = `data x;\n  if x then do; ${comment}\n    x=1;\n  end;\nrun;\n`
  const expected = `data x;\n  if x then do;\n    ${comment}\n    x=1;\n  end;\nrun;\n`
  const output = await formatText(input)
  assert.equal(output, expected)
  assert.equal(await formatText(output), output)
})

run('wrapped comments retain the correct nesting and comment form', async () => {
  const text =
    'an extremely long comment made longer than eighty characters by adding many extra words'
  const cases = [
    [
      `data x;\n if a then do;\n if b then do;\n x=1; /* ${text} */\n end; /* ${text} */\n end;\nrun;\n`,
      `data x;\n  if a then do;\n    if b then do;\n      x=1;\n      /* ${text} */\n    end;\n    /* ${text} */\n  end;\nrun;\n`
    ],
    [
      `%macro x();\n %if 1 %then %do; /* ${text} */\n %put text; %* ${text};\n %end;\n%mend x;\n`,
      `%macro x();\n  %if 1 %then %do;\n    /* ${text} */\n    %put text;\n    %* ${text};\n  %end;\n%mend x;\n`
    ],
    [`data x;\n x=1; * ${text};\nrun;\n`, `data x;\n  x=1;\n  * ${text};\nrun;\n`]
  ]
  for (const [input, expected] of cases) {
    const output = await formatText(input)
    assert.equal(output, expected)
    assert.equal(await formatText(output), output)
  }
})

run('wrapped trailing comments honor indentation options', async () => {
  const comment = '/* a comment long enough that the line has to break somewhere here */'
  const input = `data x;\n if 1 then stop; ${comment}\nrun;\n`
  for (const [options, indent] of [
    [{ tabWidth: 4 }, '    '],
    [{ useTabs: true }, '\t']
  ]) {
    const expected = `data x;\n${indent}if 1 then stop;\n${indent}${comment}\nrun;\n`
    const output = await formatText(input, options)
    assert.equal(output, expected)
    assert.equal(await formatText(output, options), output)
  }
})

run('a blank line under a doxygen header survives', async () => {
  // The header is a statement of its own, and the printer joined it to the
  // statement below with a single break, so the blank line an author leaves
  // between the two - the one every @sasjs/core file has - disappeared on
  // every format.
  const input = ['/**', '  @file', '  @brief one line', '**/', '', '%put x;', ''].join('\n')

  const output = await formatText(input)

  assert.equal(output, input)
  assert.equal(await formatText(output), output)
})

run('a blank line between a comment and the statement below it survives', async () => {
  // The same break inside a block, where the comment is attached to the
  // statement rather than standing on its own.
  const input = ['data work.foo;', '  /* split out */', '', '  x=1;', 'run;', ''].join('\n')

  const output = await formatText(input)

  assert.equal(output, input)
  assert.equal(await formatText(output), output)
})

import { checkCardsCasing } from './cards-casing-cases.mjs'

run('all cards variants preserve data during keyword casing', async () => {
  await checkCardsCasing(formatText)
})

run('keyword casing changes the cards opener but not its data', async () => {
  const input = 'data x; input x $; datalines /* keep data */;\nrun;\ndata test;\n;\nrun;\n'
  const output = await formatText(input, { keywordCase: 'upper' })
  assert.ok(output.includes('DATALINES /* keep data */;\nrun;\ndata test;\n;\n'), output)
  assert.match(output, /INPUT x/)
  assert.equal(await formatText(output, { keywordCase: 'upper' }), output)
})

run('keyword casing cannot change raw datalines records', async () => {
  const input = 'data x; input x $; datalines;\nrun;\ndata test;\n;\nrun;\n'
  const output = await formatText(input, { keywordCase: 'upper' })
  assert.ok(output.includes('\nrun;\ndata test;\n;\n'), output)
  assert.equal(await formatText(output, { keywordCase: 'upper' }), output)
})

run('keyword casing cannot change literals after crossed cards data', async () => {
  const input = 'parmcards4;\ndata test;\n"x\n;;;;\n%let x="DATA; PROC PRINT;";'
  const output = await formatText(input, { keywordCase: 'lower' })
  assert.ok(output.includes('%let x="DATA; PROC PRINT;";'), output)
  assert.equal(await formatText(output, { keywordCase: 'lower' }), output)
})

run('mask fallback protects cards openers in the preserved suffix from casing', async () => {
  const suffix = "%let x=%str('%');\ndata x;\ndatalines;\nabc\n;\nrun;\n"
  for (const keywordCase of ['upper', 'lower']) {
    const output = await formatText('%let before=1;\n' + suffix, { keywordCase })
    assert.ok(output.endsWith(suffix), output)
    assert.equal(await formatText(output, { keywordCase }), output)
  }
})

run('cards data tokens that cross the terminator cannot delete following code', async () => {
  for (const keyword of ['datalines', 'datalines4', 'parmcards4']) {
    for (const comment of ['', ' /* c */']) {
      for (const record of ['"unclosed', '/* unclosed']) {
        const terminator = keyword.endsWith('4') ? ';;;;' : ';'
        const input = `data x; ${keyword}${comment};\n${record}\n${terminator}\n%put TAILMARKER;\n`
        const output = await formatText(input)
        assert.ok(output.includes(`\n${record}\n${terminator}\n`), output)
        assert.ok(output.includes('%put TAILMARKER;'), output)
        assert.equal(await formatText(output), output)
      }
    }
  }
})

run('indented four-semicolon records stay inside DATA step cards4 sections', async () => {
  for (const keyword of ['datalines4', 'cards4', 'lines4']) {
    for (const eol of ['\n', '\r\n']) {
      const section = [keyword + ';', '  ;;;;', '  abc   def', ';;;;'].join(eol)
      const input = ['data x; input x $;', section, 'proc print; run;', ''].join(eol)
      const output = await formatText(input)
      assert.ok(output.includes(section), keyword + JSON.stringify(output))
      assert.equal(await formatText(output), output)
    }
  }
})

run('DATA step cards4 ends when columns one through four are semicolons', async () => {
  for (const keyword of ['datalines4', 'cards4', 'lines4']) {
    for (const suffix of ['', 'x']) {
      const input = `data x; input x $; ${keyword};\nrecord\n;;;;${suffix}\n%put done;\n`
      const output = await formatText(input)
      assert.ok(output.includes(`${keyword};\nrecord\n;;;;${suffix}`), keyword)
      assert.ok(output.includes('%put done;'), keyword)
      assert.equal(await formatText(output), output)
    }
  }
})

run('a comment between cards keyword and semicolon preserves all records', async () => {
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
    for (const eol of ['\n', '\r\n']) {
      const section = [
        keyword + ' /* hi */;',
        '  a   b',
        keyword.endsWith('4') ? ';;;;' : ';'
      ].join(eol)
      const input = ['data x; input x $;', section, 'proc print; run;', ''].join(eol)
      const output = await formatText(input)
      assert.ok(output.includes(section), keyword + JSON.stringify(output))
      assert.equal(await formatText(output), output)
    }
  }
})

run('same-line statements before datalines are not duplicated', async () => {
  const input = 'data work.x; input x $; datalines;\n%str(a /* c */ b)\n;\nrun;\n'
  const output = await formatText(input)
  assert.equal(output, 'data work.x;\n  input x $;\ndatalines;\n%str(a /* c */ b)\n;\nrun;\n')
  assert.equal(await formatText(output), output)
})

run(
  'cards variants preserve records and preceding code across layouts and line endings',
  async () => {
    for (const keyword of ['datalines', 'cards', 'lines', 'parmcards']) {
      for (const suffix of ['', '4']) {
        for (const eol of ['\n', '\r\n']) {
          for (const terminated of [true, false]) {
            for (const sameLine of [true, false]) {
              const name = keyword + suffix
              const prefix =
                keyword === 'parmcards' ? 'filename f temp;' : 'data work.x; input x $;'
              const data = ['  one  x', '   ;data', 'two;three'].join(eol)
              const terminator = suffix ? ';;;;' : ';'
              const section = name + ';' + eol + data + (terminated ? eol + terminator : '')
              const input =
                '  ' +
                prefix +
                (sameLine ? '   ' : eol + '  ') +
                section +
                (terminated ? eol + 'run;' : '') +
                eol
              const output = await formatText(input)
              const label = `${name} ${JSON.stringify(eol)} terminated=${terminated} sameLine=${sameLine}`
              assert.ok(
                output.includes(section),
                `${label}: section changed: ${JSON.stringify(output)}`
              )
              assert.equal(
                (
                  output.match(keyword === 'parmcards' ? /filename f temp;/g : /data work\.x;/g) ||
                  []
                ).length,
                1,
                label
              )
              if (keyword !== 'parmcards')
                assert.equal((output.match(/input x \$;/g) || []).length, 1, label)
              if (!sameLine)
                assert.ok(output.includes('  ' + section), `${label}: indentation lost`)
              if (terminated) assert.equal((output.match(/run;/g) || []).length, 1, label)
              assert.equal(await formatText(output), output, label)
            }
          }
        }
      }
    }
  }
)

run('unterminated cards preserve trailing blank records', async () => {
  for (const keyword of ['datalines', 'cards', 'lines', 'parmcards']) {
    for (const suffix of ['', '4']) {
      for (const eol of ['\n', '\r\n']) {
        for (const sameLine of [true, false]) {
          const section = [keyword + suffix + ';', 'a', '', ''].join(eol)
          const input = 'filename f temp;' + (sameLine ? ' ' : eol) + section + eol
          const output = await formatText(input)
          assert.ok(output.endsWith(section + '\n'), JSON.stringify(output))
          assert.equal(await formatText(output), output)
        }
      }
    }
  }
})

run('a cards section keeps the suffix when a token crosses its terminator', async () => {
  const input =
    'filename f temp; parmcards4 /* opener */;\nunterminated "quote\n;;;;\n%put after;\n'
  const output = await formatText(input)
  assert.ok(
    output.includes('parmcards4 /* opener */;\nunterminated "quote\n;;;;\n%put after;'),
    JSON.stringify(output)
  )
  assert.equal((output.match(/filename f temp;/g) || []).length, 1)
  assert.equal(await formatText(output), output)
})

run('cards token boundary fallback keeps raw data, suffix and EOF blank records', async () => {
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
    for (const comment of ['', ' /* opener */']) {
      for (const raw of ['unclosed "quote', "unclosed 'quote", 'unclosed /* comment']) {
        for (const eols of [
          ['\n', '\n', '\n', '\n'],
          ['\r\n', '\n', '\r\n', '\n']
        ]) {
          const end = keyword.endsWith('4') ? ';;;;' : ';'
          const section =
            keyword +
            comment +
            ';' +
            eols[0] +
            raw +
            eols[1] +
            end +
            eols[2] +
            '%put    after;' +
            eols[3] +
            '\n\n'
          const input = 'filename f temp; ' + section
          const output = await formatText(input)
          const label = `${keyword} ${comment} ${raw} ${JSON.stringify(eols)}`
          assert.ok(output.includes(section.slice(0, -1)), `${label}: ${JSON.stringify(output)}`)
          assert.equal((output.match(/filename f temp;/g) || []).length, 1, label)
          assert.equal((output.match(/%put    after;/g) || []).length, 1, label)
          assert.equal(await formatText(output), output, label)
        }
      }
    }
  }
})

run('cards with aligned tokens still format the suffix normally', async () => {
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
    for (const comment of ['', ' /* opener */']) {
      const input = `filename f temp; ${keyword}${comment};\nplain record\n${keyword.endsWith('4') ? ';;;;' : ';'}\n%put    after;\n`
      const output = await formatText(input)
      assert.ok(output.includes('%put after;'), JSON.stringify(output))
      assert.equal(await formatText(output), output)
    }
  }
})

run('unterminated cards retain incomplete quoted and commented records to EOF', async () => {
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
    for (const raw of ['unfinished "quote', 'unfinished /* comment']) {
      for (const ending of ['', '\n', '\n\n\n', '\r\n\r\n\r\n']) {
        const section = `${keyword} /* opener */;\n${raw}${ending}`
        const output = await formatText('filename f temp; ' + section)
        const expected = ending ? section.slice(0, -(ending.endsWith('\r\n') ? 2 : 1)) : section
        assert.ok(output.includes(expected), JSON.stringify(output))
        assert.equal((output.match(/filename f temp;/g) || []).length, 1)
        assert.equal(await formatText(output), output)
      }
    }
  }
})

run('a cards section is printed as it was written', async () => {
  // The body of a cards section is data. It used to be reflowed as statements
  // - the indentation dropped, and `;;;;` split into one semicolon on the last
  // data line plus three lines of `;` - which no longer reads as a terminator
  // to anything scanning for one.
  const section = ['parmcards4;', '  %put hello;', ';;;;']
  const input = ['filename ft15f001 temp;', ...section, '', '%put done;', ''].join('\n')

  const output = await formatText(input)

  assert.deepEqual(output.split('\n').slice(1, 4), section)
  assert.equal(output, input)
  assert.equal(await formatText(output), output)
})

run('a datalines section inside a DATA step keeps its records and terminator', async () => {
  // The formatter moved the section's closing semicolon onto its last record -
  // `3,4` came back as `3,4;` - so it changed the data as well as the layout,
  // and the statement after the step ran against a corrupted dataset.
  const records = ['1,2', '3,4']
  const input = [
    'data work.foo;',
    '  infile datalines dsd;',
    '  input a b;',
    '  datalines;',
    ...records,
    ';',
    'run;',
    ''
  ].join('\n')

  const output = await formatText(input)

  assert.equal(output, input)
  assert.deepEqual(output.split('\n').slice(4, 6), records)
  assert.equal(await formatText(output), output)
})

run('a cards section inside a block keeps its body and terminator', async () => {
  // The section is printed as it was written, including its own indentation -
  // see the patch that does it. What must not change is the data: the records,
  // their leading columns, and the `;;;;` terminator.
  const section = ['  parmcards4;', '      x', '  ;;;;']
  const input = [
    '%macro nested_cards();',
    '  %if 1 %then %do;',
    '    filename f temp;',
    ...section,
    '  %end;',
    '%mend nested_cards;',
    ''
  ].join('\n')

  const output = await formatText(input)
  const lines = output.split('\n')

  for (const line of section) {
    assert.ok(
      lines.includes(line),
      `the section must survive as written: ${JSON.stringify(line)} missing from ${JSON.stringify(output)}`
    )
  }
  assert.equal(await formatText(output), output)
})

run('a parmcards4 section carries its own semicolons as data', async () => {
  // The section carries a SAS program, so a lone `;` record is an empty
  // statement in it - not the end of the section. Ending there reflowed the
  // rest of the carried program and split the real terminator into statements.
  const section = ['parmcards4;', '  data x;', '  ;', '  run;', ';;;;']
  const input = ['filename ft15f001 temp;', ...section, ''].join('\n')

  const output = await formatText(input)

  assert.deepEqual(output.split('\n').slice(1, 6), section)
  assert.equal(output, input)
  assert.equal(await formatText(output), output)
})

run('a datalines record that begins with blanks and a semicolon is data', async () => {
  // SAS ends a plain datalines section only at a line whose FIRST character is
  // a semicolon; leading blanks make the line a record. Reading the trimmed
  // line ended the section mid-data and folded the rest into a statement.
  const records = ['  ab', '   ;cd', '  ef']
  const input = [
    'data work.foo;',
    '  infile datalines dsd;',
    '  input a $;',
    '  datalines;',
    ...records,
    ';',
    '',
    'run;',
    ''
  ].join('\n')

  const output = await formatText(input)

  assert.deepEqual(output.split('\n').slice(4, 7), records)
  assert.equal(output, input)
  assert.equal(await formatText(output), output)
})

run('a macro that returns a value keeps its %mend on a line of its own', async () => {
  // `&x %mend f;` is how every value-returning macro in @sasjs/core ends. The
  // return value has no semicolon, so nothing ended the statement and the
  // printer glued the closing keyword onto the value's line - which both read
  // wrongly and tripped `hasMacroNameInMend` with a "Missing %mend" warning.
  const input = [
    '%macro mf_value();',
    '  %local x;',
    '  %let x=1;',
    '',
    '  &x',
    '%mend mf_value;',
    ''
  ].join('\n')

  const output = await formatText(input)

  assert.equal(output, input)
  assert.equal(await formatText(output), output)
})

run('a cards section followed by a DATA step does not gain a blank line', async () => {
  // A statement that opens a region already prints with a blank line before it.
  // Carrying the author's blank as well printed two, and a second format added
  // a third, so the buffer grew on every run.
  const section = ['cards4;', 'x', ';;;;']
  const input = [...section, 'data b;', '  y=1;', 'run;', ''].join('\n')

  const output = await formatText(input)

  assert.deepEqual(output.split('\n').slice(0, 4), [...section, ''])
  assert.equal(output.split('\n')[4], 'data b;')
  const again = await formatText(output)
  assert.equal(again, output)
})

run('an unterminated datalines section inside a DATA step is left as it was read', async () => {
  // A section with no terminator is what a truncated member looks like. The
  // section has to be read as data to the end of the buffer - the formatter
  // instead ended it nowhere, kept the section, and added a blank line after it
  // on every run, so the file never settled.
  const input = ['data x;', '  input a;', 'datalines;', '1,2', '3,4', ''].join('\n')

  const output = await formatText(input)

  assert.equal(output, input)
  assert.equal(await formatText(output), output)
})

run('an unterminated cards section at the top level keeps its records apart', async () => {
  // The same section in open code was reflowed as statements, which joined the
  // records onto one line - a data change, not a layout change.
  const records = ['1,2', '3,4']
  const input = ['datalines;', ...records, ''].join('\n')

  const output = await formatText(input)

  assert.deepEqual(output.split('\n').slice(1, 3), records)
  assert.equal(output, input)
  assert.equal(await formatText(output), output)
})

run('an unterminated parmcards4 section keeps the program it carries', async () => {
  // The `4` variants end at a line of four or more semicolons; with none, the
  // carried program is data to the end of the buffer and must not be reflowed.
  const section = ['parmcards4;', '  data x;', '  run;']
  const input = ['filename ft15f001 temp;', ...section, ''].join('\n')

  const output = await formatText(input)

  assert.equal(output, input)
  assert.equal(await formatText(output), output)
})

run('keyword casing preserves masked text and applies to surrounding code', async () => {
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
    const output = await formatText(input, { keywordCase })
    assert.equal(output, expected)
    assert.equal(await formatText(output, { keywordCase }), output)
  }
})

run('keyword casing handles ordinary masks, comments and cards data', async () => {
  for (const suffix of ['%let x=%str(&a);', '%put %str(a,b);', '/* %str(a,b) */']) {
    const output = await formatText(`data x;run;\n${suffix}\n`, { keywordCase: 'upper' })
    assert.ok(output.startsWith('DATA x;\nRUN;\n'), output)
  }
  for (const keywordCase of ['upper', 'lower']) {
    const source = keywordCase === 'upper' ? '%let' : '%LET'
    const expected = keywordCase === 'upper' ? '%LET' : '%let'
    for (const fragment of ['%str(&a)', '%str(a,b)', '/* %str(a,b) */']) {
      const input = `${source} x=${fragment};\n${source} y=1;\n`
      const output = await formatText(input, { keywordCase })
      assert.ok(output.startsWith(expected), JSON.stringify(output))
      assert.ok(output.includes(`${expected} y=1;`), JSON.stringify(output))
      assert.equal(await formatText(output, { keywordCase }), output)
    }
    const records = keywordCase === 'upper' ? 'run;\ndata test;' : 'RUN;\nDATA TEST;'
    const cards = await formatText(`data x; input x $; datalines;\n${records}\n;\nrun;\n`, {
      keywordCase
    })
    assert.ok(cards.includes(`\n${records}\n;\n`), JSON.stringify(cards))
  }
  const input = '%let x = %str(ordinary);\n%put tail;\n'
  for (const [keywordCase, expected] of [
    ['preserve', '%let x=%str(ordinary);\n%put tail;\n'],
    ['upper', '%LET x=%STR(ordinary);\n%PUT tail;\n'],
    ['lower', '%let x=%str(ordinary);\n%put tail;\n']
  ])
    assert.equal(await formatText(input, { keywordCase }), expected)
})

run('quote functions preserve arguments and case code outside', async () => {
  for (const name of ['str', 'nrstr', 'quote', 'nrquote', 'bquote', 'nrbquote', 'superq']) {
    const argument = '%put hello;'
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

run('nested multiline masks preserve arguments and resume casing afterwards', async () => {
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
})

run('unsafe masks preserve later literals and case only the safe prefix', async () => {
  for (const keywordCase of ['preserve', 'upper', 'lower']) {
    for (const literal of ["'begin; proc print; end'", "'BEGIN; PROC PRINT; END'"]) {
      const prefix = keywordCase === 'lower' ? '%LET' : '%let'
      const wanted = keywordCase === 'upper' ? '%LET' : '%let'
      const suffix = `%let x=%str('%');\ndata a; x=${literal}; run;\n`
      const output = await formatText(`${prefix} before=1;\n${suffix}`, { keywordCase })
      assert.equal(output, `${keywordCase === 'preserve' ? prefix : wanted} before=1;\n${suffix}`)
      assert.equal(await formatText(output, { keywordCase }), output)
    }
  }
})

run('masking arguments at EOF survive every keyword case', async () => {
  for (const keywordCase of ['preserve', 'upper', 'lower']) {
    for (const input of ["%put %str('%')", "%put %nrstr(a; %str('%'); b)"]) {
      const output = await formatText(input, { keywordCase })
      assert.equal(output, input + '\n')
      assert.equal(await formatText(output, { keywordCase }), output)
    }
    for (const input of [
      '%let x=%nrstr(foo\n%put TAIL;\n\n\n',
      "%let x=%str('%');\n%put %nrstr(a;\n\n"
    ]) {
      assert.equal(await formatText(input, { keywordCase }), input)
    }
  }
})

run(
  'casing handles a flat AST with 140000 statements',
  async () => {
    const input = '%put hello;\n'.repeat(140000)
    assert.equal(await formatText(input, { keywordCase: 'upper' }), '%PUT hello;\n'.repeat(140000))
  },
  { timeout: 120000 }
)

run('a comment within a masking argument does not delete preceding text', async () => {
  const input = '%let x=%str(a; /* c */ b);\n'
  const output = await formatText(input)
  assert.equal(output, input)
  assert.equal(await formatText(output), output)
})

run('masking arguments preserve comments and adjacent text', async () => {
  const cases = [
    '%let x=%str(a /* c */ b /* d */ c);\n',
    '%let x=%nrstr(foo; /* one */ bar; /* two */ baz);\n',
    '%let x=%str(a /* comment */ (b) c);\n',
    '%let x=%str(a /* ) */ b);\n',
    '%let x=%str(a; /* c */ b) suffix text;\n',
    '%macro x();\n  %let x=%str(a; /* c */ b);\n%mend x;\n',
    '%let x=%str(a; /* c\n d */ b);\n',
    '%let x=%str /* c */ (a; b);\n',
    '%let x=%str(a /* c */ b;\n'
  ]
  for (const input of cases) {
    const output = await formatText(input)
    assert.equal(output, input)
    assert.equal(await formatText(output), output)
  }
})

run('a masking argument that spans statements is printed as it was written', async () => {
  // `%nrstr(` with a whole program as its argument: the lexer still tokenises
  // that program as code, so a `proc` or `data` inside it opened a region and
  // abandoned the statement the masking call belonged to. The print pass then
  // popped tokens from a statement that had none left and threw, so the
  // formatter refused the file and left the buffer unchanged. What must hold is
  // that the masked program survives as written; capturing the call through its
  // matching `)` verbatim is what a cards section already does.
  const masked = [
    '    /* Read in the table list */',
    '    proc cas;',
    '      table.fileinfo result=source_list /caslib="&lib";',
    '    quit;',
    '    data &outprefix._&lib;',
    "      set &outprefix._&lib(where=(upcase(Name) like '%.SASHDAT'));",
    '    run;'
  ]
  const input = [
    '%macro mfv_existsashdat(libds,outprefix=work.mfv_existsashdat);',
    '%local rc;',
    '%if %sysfunc(exist(&outprefix)) ne 1 %then %do;',
    '  %let rc=%sysfunc(dosubl(%nrstr(',
    ...masked,
    '  )));',
    '%end;',
    '%mend mfv_existsashdat;',
    ''
  ].join('\n')

  const output = await formatText(input)

  for (const line of masked) {
    assert.ok(
      output.includes(line),
      `the masked program must survive as written: ${JSON.stringify(line)} missing from ${JSON.stringify(output)}`
    )
  }
  assert.equal(await formatText(output), output)
})

run('a masking argument with no closing parenthesis keeps the buffer', async () => {
  // A mask that is never closed is a truncated member, or a call whose
  // parenthesis lives elsewhere. Leaving the region open deleted everything
  // after the call - the tokens were popped and never re-emitted - so the rest
  // of the buffer is taken verbatim with the call, as an unterminated cards
  // section is.
  const input = ['%let x=%nrstr(', '  data y;', '    z=1;', '  run;', ''].join('\n')

  const output = await formatText(input)

  assert.equal(output, input)
  assert.equal(await formatText(output), output)
})

run('a masked parenthesis inside the argument does not end the capture', async () => {
  // %( and %) are the macro language's masked parentheses - text to the
  // compiler, not parentheses. Counting one as a real one mislocates the
  // parenthesis that closes the argument, and the code after the call was
  // silently reformatted as part of it. Each of them is unbalanced on its own,
  // so a count that treats them as real cannot land on the same place.
  const inputs = [
    ['  data q;', '    y=1;', '  run;', '  %put not %) a real close;'],
    ['  data r;', '    z=1;', '  run;', '  %put %( left open;']
  ]

  for (const masked of inputs) {
    const input = ['%let a=%nrstr(', ...masked, ');', '%let tail= 1;', ''].join('\n')

    const output = await formatText(input)

    for (const line of masked) {
      assert.ok(
        output.includes(line),
        `the masked program must survive as written: ${JSON.stringify(line)} missing from ${JSON.stringify(output)}`
      )
    }
    assert.ok(
      output.trimEnd().endsWith('%let tail=1;'),
      `the statement after the call must still be code: ${JSON.stringify(output)}`
    )
    assert.equal(await formatText(output), output)
  }
})

run('a masking argument before a DATA or PROC step is stable', async () => {
  const mask = ['%let a=%nrstr(', '  data q;', '    y=1;', '  run;', ');'].join('\n')
  for (const tail of ['data tail; x=1; run;', 'proc print data=q; run;']) {
    for (const gap of ['\n', '\n\n']) {
      const output = await formatText(mask + gap + tail + '\n')
      assert.ok(output.startsWith(mask + '\n\n' + tail.split(';')[0] + ';\n'))
      assert.equal(await formatText(output), output)
    }
  }
})

run('a masking argument before an ordinary statement keeps the blank line', async () => {
  const mask = ['%let a=%nrstr(', '  data q;', '  run;', ');'].join('\n')
  const output = await formatText(mask + '\n\n%let tail= 1;\n')
  assert.equal(output, mask + '\n\n%let tail=1;\n')
  assert.equal(await formatText(output), output)
})

run('paired percent signs do not mask the following parenthesis', async () => {
  const mask = ['%let a=%str(', '  data q;', '    y=1;', '  run;', '  20%%);'].join('\n')
  const output = await formatText(mask + '\n%let tail= 1;\n')
  assert.ok(output.startsWith(mask))
  assert.ok(output.trimEnd().endsWith('%let tail=1;'))
  assert.equal(await formatText(output), output)
})

run('a masking call after another statement does not duplicate it', async () => {
  const input = '%put hi; %let x=%nrstr(data q; run;);\n'
  const output = await formatText(input)
  assert.equal(output, '%put hi;\n%let x=%nrstr(data q; run;);\n')
  assert.equal(await formatText(output), output)
})

run('a multiline string inside a masking argument remains verbatim', async () => {
  const input = [
    '%let a=%nrstr(',
    ' data q;',
    ' x="a',
    ')b(";',
    ' proc print; run;',
    ');',
    '%let tail= 1;',
    ''
  ].join('\n')
  const output = await formatText(input)
  assert.ok(output.includes(' x="a\n)b(";\n proc print; run;'))
  assert.ok(output.trimEnd().endsWith('%let tail=1;'))
  assert.equal(await formatText(output), output)
})

run('text after a masking call keeps its whitespace', async () => {
  for (const input of [
    '%let x=%str(proc print; run;) suffix text;\n',
    '%put %str(proc print; run;) #  #;\n',
    '%let x=%sysfunc(dosubl(%nrstr(proc print; run;))) suffix text;\n'
  ]) {
    const output = await formatText(input)
    assert.equal(output, input)
    assert.equal(await formatText(output), output)
  }
})

run('a masking argument on one line is still formatted around, not captured', async () => {
  // The verbatim path is for an argument that spans statements. A masking call
  // whose argument is one expression keeps the statement's own layout.
  const input = ['data x;', '  y=%nrstr(a b);', 'run;', ''].join('\n')

  const output = await formatText(input)

  assert.equal(output, input)
  assert.equal(await formatText(output), output)
})
