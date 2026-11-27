import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const anchor = `      quoting = preserveQuoting(quoting, currentStatement, model);
      if (quoting >= 0) {
        continue;
      }

      //#region --- Check for statement end
      if (node.type === "sep" && node.text === ";") {`

/**
 * The parser source the patches expect around `anchor`: every patch that
 * targets the parser states the code it replaces, and a patch whose anchor is
 * missing fails the build rather than being skipped - so a fixture that holds
 * only one of them cannot stand in for the file.
 */
const fixtureSource = [
  `export interface Statement {
  type: "statement";
  name: string;
  children: Token[];
  leadingComment?: Token;
}`,
  `      } else if (currentStatement.children.length === 1 && isComment(node)) {
        // standalone comment, treat as a whole statement
        prevStatement = currentStatement;`,
  `            if (prevStatement.children.length === 1 && isComment(prevToken)) {
              // leading comment will be printed together with current statement`,
  `      //#region --- Check for statement start
      if (!currentStatement) {`,
  `          if (lineGap > minGapToPreserve) {`,
  `      currentStatement.children.push(node);

      preserveCustom = preserveCustomRegion(`,
  anchor
].join('\n\n')

const fixture = async (t, source, inject = false) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sasjs-patch-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'scripts'), { recursive: true })
  const parser = path.join(dir, '.upstream/server/server/src/sas/formatter/parser.ts')
  await mkdir(path.dirname(parser), { recursive: true })
  await copyFile(
    path.join(root, 'scripts/upstream-patches.mjs'),
    path.join(dir, 'scripts/upstream-patches.mjs')
  )
  if (inject) {
    const modulePath = path.join(dir, 'scripts/upstream-patches.mjs')
    const moduleSource = await readFile(modulePath, 'utf8')
    const marker = '      const callTokens = currentStatement.children;'
    assert.ok(moduleSource.includes(marker))
    await writeFile(
      modulePath,
      moduleSource.replace(marker, () => `${marker}\n      // $& $' $$ $1`)
    )
  }
  await writeFile(parser, source)
  const { patchUpstream } = await import(
    pathToFileURL(path.join(dir, 'scripts/upstream-patches.mjs'))
  )
  return { parser, patchUpstream }
}

test('upstream patches insert replacement text literally', async (t) => {
  const { parser, patchUpstream } = await fixture(t, `before\n${fixtureSource}\nafter`, true)
  patchUpstream()
  const patched = await readFile(parser, 'utf8')
  assert.ok(patched.includes("// $& $' $$ $1"))
  assert.ok(patched.endsWith('\nafter'))
})

test('upstream parser patch rejects duplicate contextual anchors', async (t) => {
  const { parser, patchUpstream } = await fixture(t, `${fixtureSource}\n${anchor}`)
  assert.throws(() => patchUpstream(), /multiple|more than one|not unique/i)
  assert.equal(await readFile(parser, 'utf8'), `${fixtureSource}\n${anchor}`)
})

test('macro end patch is independent of the mend patch comment', async (t) => {
  const { parser, patchUpstream } = await fixture(t, fixtureSource)
  patchUpstream()
  const source = await readFile(parser, 'utf8')
  const start = source.indexOf(
    '      // End a semicolon-less value before a whitespace-separated %end.'
  )
  const end = source.indexOf('      //#region --- Check for statement start', start)
  assert.ok(start >= 0 && end > start)
  const oldMendOnly = source.slice(0, start) + source.slice(end)
  await writeFile(
    parser,
    oldMendOnly.replace(
      'A %mend starts a statement of its own, so a statement still open when',
      'A %mend starts a statement of its own, with revised prose'
    )
  )
  patchUpstream()
  const result = await readFile(parser, 'utf8')
  assert.match(result, /End a semicolon-less value before a whitespace-separated %end/)
  const once = result
  patchUpstream()
  assert.equal(await readFile(parser, 'utf8'), once)
})

test('upstream parser patch applies once and remains idempotent', async (t) => {
  const { parser, patchUpstream } = await fixture(t, fixtureSource)
  patchUpstream()
  const once = await readFile(parser, 'utf8')
  assert.match(once, /const standaloneMacroCall = completeMacroCall/)
  patchUpstream()
  assert.equal(await readFile(parser, 'utf8'), once)
})
