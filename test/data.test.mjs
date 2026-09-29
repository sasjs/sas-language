/**
 * Guards the published data and the transforms over it.
 *
 * The drift checks matter most: `provenance.json` records a sha256 per generated
 * file, so a data file edited by hand, or a build run against a stale
 * .upstream/, fails here rather than shipping silently.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA = path.join(ROOT, 'data')

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

const provenance = await readJson(path.join(ROOT, 'provenance.json'))
const catalogue = await readJson(path.join(DATA, 'index.json'))

test('provenance names the upstream source and a resolved commit', () => {
  assert.match(provenance.source, /^https:\/\/github\.com\/sassoftware\/vscode-sas-extension$/)
  assert.equal(provenance.license, 'Apache-2.0')
  assert.ok(provenance.upstreamRef, 'upstreamRef is recorded')
  assert.ok(provenance.groups.length >= 20, 'all groups are recorded')
})

test('every group has an index and a docs file', async () => {
  const files = await readdir(DATA)
  for (const { group } of catalogue.groups) {
    assert.ok(files.includes(`${group}.index.json`), `${group}.index.json exists`)
    assert.ok(files.includes(`${group}.docs.json`), `${group}.docs.json exists`)
  }
})

test('the data matches the provenance hashes', async () => {
  for (const entry of provenance.groups) {
    for (const [suffix, key] of [
      ['index', 'indexSha256'],
      ['docs', 'docsSha256']
    ]) {
      const text = await readFile(path.join(DATA, `${entry.group}.${suffix}.json`), 'utf8')
      assert.equal(
        sha256(text),
        entry[key],
        `${entry.group}.${suffix}.json is unchanged since the build recorded it`
      )
    }
  }
})

test('every index entry is well formed and unique', async () => {
  for (const { group } of catalogue.groups) {
    const index = await readJson(path.join(DATA, `${group}.index.json`))
    assert.equal(index.count, index.entries.length, `${group} count matches its entries`)
    assert.ok(index.count > 0, `${group} is not empty`)
    assert.equal(typeof index.kind, 'number', `${group} carries a completion kind`)

    const seen = new Set()
    for (const tuple of index.entries) {
      assert.ok(Array.isArray(tuple) && tuple.length >= 2, `${group} entry is a tuple`)
      const [name, type, takesValue] = tuple
      assert.ok(typeof name === 'string' && name.length > 0, `${group} name is a string`)
      assert.ok(typeof type === 'string' && type.length > 0, `${group}: ${name} has a type`)
      assert.ok(
        takesValue === undefined || takesValue === 1,
        `${group}: ${name} flag is 1 or absent`
      )
      assert.ok(!seen.has(name), `${group}: ${name} appears once`)
      seen.add(name)
    }
  }
})

test('every documented entry carries help text', async () => {
  for (const { group } of catalogue.groups) {
    const docs = await readJson(path.join(DATA, `${group}.docs.json`))
    for (const [name, entry] of Object.entries(docs.entries)) {
      assert.ok(
        typeof entry.help === 'string' && entry.help.trim().length > 0,
        `${group}: ${name} has help`
      )
    }
  }
})

test('groups are populated in the range the upstream data implies', async () => {
  const byGroup = Object.fromEntries(catalogue.groups.map((g) => [g.group, g.count]))
  // Loose lower bounds: they catch an empty or truncated publish without
  // failing every time SAS adds a procedure.
  assert.ok(byGroup.functions > 600, `functions: ${byGroup.functions}`)
  assert.ok(byGroup.procNames > 350, `procNames: ${byGroup.procNames}`)
  assert.ok(byGroup.statements > 90, `statements: ${byGroup.statements}`)
  assert.ok(byGroup.systemOptions > 300, `systemOptions: ${byGroup.systemOptions}`)
  assert.ok(byGroup.sqlKeywords > 35, `sqlKeywords: ${byGroup.sqlKeywords}`)
})

test('known SAS words are present', async () => {
  const names = async (group) => {
    const index = await readJson(path.join(DATA, `${group}.index.json`))
    return new Set(index.entries.map(([name]) => name))
  }

  assert.ok((await names('functions')).has('ABS'), 'ABS is a function')
  assert.ok((await names('procNames')).has('MEANS'), 'MEANS is a procedure')
  assert.ok((await names('statements')).has('DATA'), 'DATA is a statement')
  assert.ok((await names('sqlKeywords')).has('SELECT'), 'SELECT is a SQL keyword')
  assert.ok((await names('odsTagsets')).has('CSV'), 'CSV is an ODS destination')
})

test('an option that takes a value is flagged and inserts its equals', async () => {
  const index = await readJson(path.join(DATA, 'options.index.json'))
  const bufno = index.entries.find(([name]) => name === 'BUFNO')
  assert.ok(bufno, 'BUFNO is present')
  assert.equal(bufno[2], 1, 'BUFNO is flagged as taking a value')
})

test('transforms unpack, label and insert correctly', async () => {
  const { toEntries, completionItems, docsFor, words } = await import('../dist/index.js')

  const index = await readJson(path.join(DATA, 'functions.index.json'))
  const entries = toEntries(index)
  assert.equal(entries.length, index.count)
  assert.deepEqual(entries[0], {
    name: index.entries[0][0],
    type: index.entries[0][1],
    takesValue: false
  })

  const items = completionItems(index)
  assert.equal(items.length, index.count)
  assert.ok(items.every((item) => item.kind === index.kind))
  assert.ok(items.every((item) => item.detail.startsWith('SAS function')))
  assert.ok(words(index).includes('ABS'))

  const options = await readJson(path.join(DATA, 'options.index.json'))
  const bufno = completionItems(options).find((item) => item.label === 'BUFNO')
  assert.equal(bufno.insertText, 'BUFNO=', 'a value option inserts its equals')

  const docs = await readJson(path.join(DATA, 'functions.index.json'))
  assert.ok(docs, 'docs fixture loads')

  const docsFile = await readJson(path.join(DATA, 'functions.docs.json'))
  assert.ok(docsFor(docsFile, 'abs'), 'docsFor matches lower case')
  assert.ok(docsFor(docsFile, 'ABS'), 'docsFor matches upper case')
  assert.equal(docsFor(docsFile, 'no-such-word'), undefined)
})
