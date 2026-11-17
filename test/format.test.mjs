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

const run = (name, fn) =>
  test(name, async (context) => {
    if (reason) return context.skip(reason)
    await fn()
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
