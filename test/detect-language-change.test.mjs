import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { listArtefacts, normaliseRefs, upstreamRefOf } from '../scripts/detect-language-change.mjs'

const OLD = 'e35d0ca2db421ee712fe2ea2d3eee8b3e0c4bef6'
const NEXT = 'b225bfd2cf66c861747d701768b21ad20be7e745'

const digest = (char) => char.repeat(64)

const provenance = (ref, indexSha = digest('a')) =>
  JSON.stringify(
    {
      source: 'https://github.com/sassoftware/vscode-sas-extension',
      license: 'Apache-2.0',
      upstreamRef: ref,
      groups: [
        {
          group: 'statements',
          count: 107,
          documented: 107,
          indexSha256: indexSha,
          docsSha256: digest('b')
        }
      ]
    },
    null,
    2
  )

test('a pin move alone compares equal', () => {
  const cases = [
    ['provenance.json', provenance(OLD), provenance(NEXT)],
    [
      'data/index.json',
      JSON.stringify({ ref: OLD, groups: [{ group: 'statements' }] }),
      JSON.stringify({ ref: NEXT, groups: [{ group: 'statements' }] })
    ],
    [
      'src/groups.generated.ts',
      `export const UPSTREAM_REF = "${OLD}"\n`,
      `export const UPSTREAM_REF = "${NEXT}"\n`
    ]
  ]

  for (const [file, before, after] of cases) {
    assert.equal(normaliseRefs(file, before), normaliseRefs(file, after), file)
  }
})

test('a per-group digest is not masked', () => {
  // provenance.json carries a sha256 per group next to the ref. The mask has to
  // find the ref by the field that holds it, or it eats the digest prefixes too
  // and a data change hides behind them.
  assert.notEqual(
    normaliseRefs('provenance.json', provenance(OLD, digest('a'))),
    normaliseRefs('provenance.json', provenance(OLD, digest('c')))
  )
})

test('a pin-shaped value in a group artefact is not a ref', () => {
  // Only the three pinned artefacts carry the upstream ref. A sha turning up in
  // a group's data is a value, not a pin, so it must not be masked.
  assert.notEqual(
    normaliseRefs('data/statements.docs.json', `ref ${OLD}`),
    normaliseRefs('data/statements.docs.json', `ref ${NEXT}`)
  )
})

test('a count change survives the pin normalisation', () => {
  const before = provenance(OLD).replace('"count": 107', '"count": 108')

  assert.notEqual(
    normaliseRefs('provenance.json', provenance(OLD)),
    normaliseRefs('provenance.json', before)
  )
})

test('the upstream ref is read from provenance.json', () => {
  assert.equal(upstreamRefOf(provenance(OLD)), OLD)
  assert.equal(upstreamRefOf(provenance(OLD.toUpperCase())), OLD)
})

test('a provenance.json without a usable ref yields null', () => {
  assert.equal(upstreamRefOf('{}'), null)
  assert.equal(upstreamRefOf('not json'), null)
  assert.equal(upstreamRefOf(JSON.stringify({ upstreamRef: 42 })), null)
})

test('the artefact listing walks nested directories', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sas-language-guard-'))

  try {
    mkdirSync(path.join(root, 'data', 'nested'), { recursive: true })
    writeFileSync(path.join(root, 'data', 'flat.json'), '{}')
    writeFileSync(path.join(root, 'data', 'nested', 'deep.json'), '{}')
    writeFileSync(path.join(root, 'data', 'notes.txt'), '')

    assert.deepEqual(listArtefacts(root), ['data/flat.json', 'data/nested/deep.json'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a directory without data/ lists nothing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sas-language-guard-'))

  try {
    assert.deepEqual(listArtefacts(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
