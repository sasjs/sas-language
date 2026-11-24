import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const require = createRequire(import.meta.url)

test('the public function snippets subpath provides the corrected VS Code templates', () => {
  const snippets = require('@sasjs/sas-language/snippets/functions.json')
  assert.equal(Object.keys(snippets).length, 223)
  for (const [name, snippet] of Object.entries(snippets)) {
    assert.equal(snippet.prefix, name)
    assert.ok(Array.isArray(snippet.body) && snippet.body.length > 0, name)
    assert.ok(
      snippet.body.every((line) => typeof line === 'string'),
      name
    )
    assert.ok(typeof snippet.description === 'string' && snippet.description.length > 0, name)
  }
  assert.deepEqual(snippets.allperm.body, ['allperm(${1:count}, of ${2:variable})'])
  assert.deepEqual(snippets.cos.body, ['cos(${1})'])
  assert.deepEqual(snippets.compound.body, [
    'compound(${1:init-amt}, ${2:future-amt}, ${3:interest-rate}, ${4:num-periods})'
  ])
})

test('the license and provenance have stable public subpaths', () => {
  const license = readFileSync(require.resolve('@sasjs/sas-language/snippets/LICENSE.txt'), 'utf8')
  const provenance = readFileSync(require.resolve('@sasjs/sas-language/snippets/README.md'), 'utf8')
  assert.match(license, /Apache License\s+Version 2\.0/)
  assert.match(provenance, /SAS Institute Inc\./)
  assert.match(provenance, /4adcfe1469e448eb28d0961be09d03cd120d4464/)
})

test('the published package includes the snippet data and its Apache attribution and license', () => {
  const reports = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      encoding: 'utf8'
    })
  )
  const report = Array.isArray(reports) ? reports[0] : reports['@sasjs/sas-language']
  const files = new Set(report.files.map(({ path }) => path))
  for (const path of [
    'snippets/functions.json',
    'snippets/README.md',
    'snippets/LICENSE.txt',
    'NOTICE'
  ]) {
    assert.ok(files.has(path), `${path} is included in the npm package`)
  }
})
