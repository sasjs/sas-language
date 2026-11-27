import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)

test('the public procedure snippets subpath exposes upstream VS Code templates', () => {
  const snippets = require('@sasjs/sas-language/snippets/procedures.json')
  for (const name of ['proc print', 'proc import', 'proc export', 'proc ds2', 'proc sql']) {
    assert.ok(snippets[name], name)
  }
  assert.equal(snippets['proc sql'].prefix, 'sql')
  assert.deepEqual(snippets['proc sql'].body, [
    'proc sql;',
    '\tselect $1',
    '\tfrom $2',
    '\twhere $3;',
    'quit;\n'
  ])
  for (const [name, snippet] of Object.entries(snippets)) {
    assert.ok(typeof snippet.prefix === 'string' && snippet.prefix.length, name)
    assert.ok(
      Array.isArray(snippet.body) && snippet.body.every((line) => typeof line === 'string'),
      name
    )
    assert.ok(typeof snippet.description === 'string' && snippet.description.length, name)
  }
})

test('procedure snippets match their recorded upstream provenance', async () => {
  const { createHash } = await import('node:crypto')
  const provenance = require('../provenance.json')
  const output = readFileSync('snippets/procedures.json')
  assert.equal(provenance.snippets.procedures.file, 'snippets/proc-snippets.json')
  assert.equal(
    provenance.snippets.procedures.sha256,
    createHash('sha256').update(output).digest('hex')
  )
  assert.equal(provenance.snippets.procedures.bytes, output.length)
})

test('the npm package includes the procedure snippets and attribution', () => {
  const reports = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' })
  )
  const report = Array.isArray(reports) ? reports[0] : reports['@sasjs/sas-language']
  const files = new Set(report.files.map(({ path }) => path))
  for (const path of ['snippets/procedures.json', 'NOTICE']) assert.ok(files.has(path), path)
})
