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

const fixture = async (t, source) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sasjs-patch-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'scripts'), { recursive: true })
  const parser = path.join(dir, '.upstream/server/server/src/sas/formatter/parser.ts')
  await mkdir(path.dirname(parser), { recursive: true })
  await copyFile(
    path.join(root, 'scripts/upstream-patches.mjs'),
    path.join(dir, 'scripts/upstream-patches.mjs')
  )
  await writeFile(parser, source)
  const { patchUpstream } = await import(
    pathToFileURL(path.join(dir, 'scripts/upstream-patches.mjs'))
  )
  return { parser, patchUpstream }
}

test('upstream parser patch rejects duplicate contextual anchors', async (t) => {
  const { parser, patchUpstream } = await fixture(t, `${anchor}\n${anchor}`)
  assert.throws(() => patchUpstream(), /multiple|more than one|not unique/i)
  assert.equal(await readFile(parser, 'utf8'), `${anchor}\n${anchor}`)
})

test('upstream parser patch applies once and remains idempotent', async (t) => {
  const { parser, patchUpstream } = await fixture(t, anchor)
  patchUpstream()
  const once = await readFile(parser, 'utf8')
  assert.match(once, /const standaloneMacroCall = completeMacroCall/)
  patchUpstream()
  assert.equal(await readFile(parser, 'utf8'), once)
})
