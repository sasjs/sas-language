/**
 * Guards the `formatText` entry point: the published `./format` import, the
 * behaviour a caller depends on, and the failure mode when the vocabulary is
 * absent.
 *
 * Two build artifacts have to exist for any of this to run - `dist/format.js`,
 * which `build:format` bundles from the upstream core, and the staged
 * `server/node` tree, which holds the language data the formatter lexes with.
 * CI's build job has the first only when the server job has run, so a missing
 * artifact is a skip with the reason printed rather than a failure, the same
 * shape as `server.test.mjs`.
 *
 * The expected output is spelled out rather than "differs from input": these
 * strings are what the printer produces, and a silent change in how it indents
 * or where it breaks a statement is exactly what a reader of this file needs to
 * see fail.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
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

run('tabs are used when they are asked for', async () => {
  // The option is prettier's `useTabs`, not the LSP's `insertSpaces`: an editor
  // passes the latter and the host maps it, which is why this is asserted here -
  // the printer ignores a name it does not know and indents with spaces.
  const output = await formatText(['data foo;', 'set bar;', 'run;', ''].join('\n'), {
    useTabs: true
  })
  assert.match(output, /^data foo;\n\tset bar;\nrun;\n$/)
})

run('a missing data root fails with the path and the way out', async () => {
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
