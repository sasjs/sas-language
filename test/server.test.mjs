/**
 * Guards the staged language server tree: the layout a consumer runs, not
 * just the entry points.
 *
 * The node build reads parts of itself from disk at runtime - the formatter's
 * impl/ modules, the typeshed stubs, the SAS documentation tree, the runtime
 * data and the message bundles - all relative to the bundle. A staging that
 * ships the entry alone boots and then fails on the first feature that reads
 * a sibling, so the tests here assert the whole shape.
 *
 * The server/ directory is a build artifact: CI's server job builds and then
 * runs this file, while the build job has not staged a server. A missing
 * tree is therefore a skip with the reason printed - not a failure - so the
 * suite tells the two situations apart instead of guessing.
 */
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(ROOT, 'server')

const exists = async (file) => {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

const staged = await exists(SERVER)

test('the browser build is a single file', async (t) => {
  if (!staged) return t.skip('no staged server: run npm run build:server')

  assert.ok(await exists(path.join(SERVER, 'browser', 'server.js')))
})

test('the node build carries its runtime directories', async (t) => {
  if (!staged) return t.skip('no staged server: run npm run build:server')

  const bundleDir = path.join(SERVER, 'node', 'dist', 'node')

  assert.ok(await exists(path.join(bundleDir, 'server.js')), 'the entry point')
  for (const dir of ['impl', 'typeshed-fallback']) {
    const entries = await readdir(path.join(bundleDir, dir))
    assert.ok(entries.length > 0, `${dir}/ is staged and not empty`)
  }
})

test('the node build parses as CommonJS', async (t) => {
  if (!staged) return t.skip('no staged server: run npm run build:server')

  const marker = JSON.parse(
    await readFile(path.join(SERVER, 'node', 'dist', 'node', 'package.json'), 'utf8')
  )
  assert.equal(marker.type, 'commonjs')
})

test('the data the node bundle resolves two levels up is staged', async (t) => {
  if (!staged) return t.skip('no staged server: run npm run build:server')

  // The bundle sits at server/node/dist/node/server.js; two levels up is
  // server/node/, where it reads pubsdata/, data/ and the message bundles.
  const parent = path.join(SERVER, 'node')

  for (const name of ['pubsdata', 'data', 'messagebundle.properties']) {
    assert.ok(await exists(path.join(parent, name)), `${name} is staged`)
  }

  const statements = await readdir(path.join(parent, 'pubsdata', 'Statements', 'en'))
  assert.ok(statements.length > 0, 'the statement help is staged')
})

test('the message bundle is readable as the server reads it', async (t) => {
  if (!staged) return t.skip('no staged server: run npm run build:server')

  const bundle = await readFile(path.join(SERVER, 'node', 'messagebundle.properties'), 'utf8')
  assert.ok(bundle.includes('='), 'the bundle carries key=value pairs')
})
