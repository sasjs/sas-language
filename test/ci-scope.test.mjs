import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Run the actual workflow step, including git diff and its path filter, against
// isolated repositories so this test cannot silently diverge from CI's guard.
async function scopeFor(t, changedPath, event = 'pull_request') {
  const workflow = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8')
  const match = workflow.match(
    /      - name: Did the server inputs change\?\n        id: scope\n        run: \|\n((?:          .*\n|\n)+)/
  )
  assert.ok(match, 'server scope step not found in CI workflow')
  const script = match[1]
    .replace(/^          /gm, '')
    .replaceAll('${{ github.event_name }}', event)
    .replaceAll('${{ github.base_ref }}', 'main')

  const dir = await mkdtemp(path.join(tmpdir(), 'sasjs-ci-scope-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '--quiet', '--initial-branch=main')
  git('config', 'user.name', 'CI scope test')
  git('config', 'user.email', 'ci-scope@example.invalid')
  await writeFile(path.join(dir, 'base'), 'base')
  git('add', 'base')
  git('commit', '--quiet', '-m', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('remote', 'add', 'origin', dir)
  git('checkout', '--quiet', '-b', 'change')
  await mkdir(path.dirname(path.join(dir, changedPath)), { recursive: true })
  await writeFile(path.join(dir, changedPath), 'changed')
  git('add', changedPath)
  git('commit', '--quiet', '-m', 'change')
  const output = path.join(dir, 'github-output')
  await writeFile(output, '')
  execFileSync('bash', ['-e', '-c', script], {
    cwd: dir,
    env: { ...process.env, GITHUB_OUTPUT: output },
    stdio: 'pipe'
  })
  return (await readFile(output, 'utf8')).trim()
}

test('server scope rebuilds for an upstream patch-only change', async (t) => {
  assert.equal(await scopeFor(t, 'scripts/upstream-patches.mjs'), 'needed=true')
})

test('server scope rebuilds for formatter test helpers and test files', async (t) => {
  for (const file of [
    'test/cards-casing-cases.mjs',
    'test/casing-narrow.test.mjs',
    'test/casing-review-fixes.test.mjs',
    'test/issue42-review.test.mjs'
  ]) {
    assert.equal(await scopeFor(t, file), 'needed=true', file)
  }
})

test('server scope still rebuilds for an existing build input', async (t) => {
  assert.equal(await scopeFor(t, 'scripts/build-server.mjs'), 'needed=true')
})

test('server scope skips unrelated and similarly named paths', async (t) => {
  assert.equal(await scopeFor(t, 'README.md'), 'needed=false')
  assert.equal(await scopeFor(t, 'scripts/upstream-patches.mjs.bak'), 'needed=false')
})

test('server scope always rebuilds on a main push', async (t) => {
  assert.equal(await scopeFor(t, 'README.md', 'push'), 'needed=true')
})
