/**
 * Turns the fetched upstream files into the two artefacts consumers load.
 *
 * For each group:
 *   data/<group>.index.json  completion index, compact tuples: [name, type, takesValue?]
 *   data/<group>.docs.json   hover documentation, keyed by name
 *
 * A group can read two upstream shapes: the extension's keyword files
 * (`{ Keywords: { Keyword: [] } }`) and the language server's flat pubsdata
 * lists. scripts/supplements.mjs then fills any SAS macro name neither carries.
 *
 * The split exists because the two have very different sizes and lifetimes: a
 * completion provider wants the whole index up front, while hover text is only
 * needed once the user points at a word, so it can be a lazy chunk.
 *
 * The build fails on an unexpected upstream shape rather than publishing a
 * quietly empty group. That is the point of the scheduled refresh: upstream
 * changing shape should break a build, not degrade a user's editor.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { GROUPS, UPSTREAM } from './groups.mjs'
import { SUPPLEMENTS } from './supplements.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(ROOT, '.upstream')
const DEST = path.join(ROOT, 'data')

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/** Upstream packs aliases with a pipe and marks value-taking options with '='. */
const parseName = (raw) => {
  const parts = String(raw ?? '').split('|')
  const names = []
  for (const part of parts) {
    let name = part.trim()
    if (!name) continue
    const takesValue = name.endsWith('=')
    if (takesValue) name = name.slice(0, -1).trim()
    // Documentation placeholders such as <integer> are not real names.
    if (!name || name.includes('<') || name.includes('>')) continue
    names.push({ name, takesValue })
  }
  return names
}

const readKeywords = async (file) => {
  const raw = await readFile(path.join(SOURCE, file), 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`)
  }
  const rows = parsed?.Keywords?.Keyword
  if (!Array.isArray(rows)) {
    throw new Error(
      `${file} has an unexpected shape: expected { Keywords: { Keyword: [] } }, got ${Object.keys(parsed ?? {}).join(', ') || 'nothing'}`
    )
  }
  return rows
}

/**
 * Reads one of the language server's `pubsdata` files. These carry the same
 * vocabulary as the data files but as a flat list, with the prose description
 * in place of the keyword help.
 */
const readPubsdata = async (file) => {
  const raw = await readFile(path.join(SOURCE, file), 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${file} has an unexpected shape: expected an array of { name, description }, got ${typeof parsed}`
    )
  }
  return parsed
}

const buildGroup = async (group) => {
  const index = new Map()
  const docs = {}

  const add = (name, type, help, takesValue, extra) => {
    if (!index.has(name)) {
      index.set(name, takesValue ? [name, type, 1] : [name, type])
    }
    if (typeof help === 'string' && help.trim()) {
      docs[name] = extra ? { help, ...extra } : { help }
    }
  }

  for (const file of group.files) {
    const rows = await readKeywords(`${UPSTREAM.dataDir}/${file}`)
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const help = row.Help?.['#cdata']
      const extra = {}
      if (row.Values) extra.values = row.Values
      if (row.ToolTips) extra.tooltips = row.ToolTips
      if (row.SubOptionsKeywords) extra.subOptions = row.SubOptionsKeywords
      if (row.Attributes) extra.attributes = row.Attributes
      if (row.States) extra.states = row.States
      for (const { name, takesValue } of parseName(row.Name)) {
        add(name, row.Type, help, takesValue, Object.keys(extra).length ? extra : undefined)
      }
    }
  }

  for (const source of group.pubsdata ?? []) {
    const rows = await readPubsdata(`${UPSTREAM.pubsDataDir}/${source.file}`)
    for (const row of rows) {
      if (!row || typeof row.name !== 'string' || !row.name) continue
      add(row.name, source.type, row.description, false)
    }
  }

  // Names upstream does not carry yet. An upstream row always wins, so this
  // list shrinks on its own as upstream fills the gaps.
  for (const [name, type] of SUPPLEMENTS[group.id] ?? []) {
    if (!index.has(name)) index.set(name, [name, type])
  }

  if (index.size === 0) {
    throw new Error(`group ${group.id} resolved to no entries from ${group.files.join(', ')}`)
  }

  const entries = [...index.values()].sort((a, b) => a[0].localeCompare(b[0]))
  const indexBody = `${JSON.stringify(
    { group: group.id, label: group.label, kind: group.kind, count: entries.length, entries },
    null,
    0
  )}\n`
  const docsBody = `${JSON.stringify({ group: group.id, count: Object.keys(docs).length, entries: docs }, null, 0)}\n`

  await writeFile(path.join(DEST, `${group.id}.index.json`), indexBody)
  await writeFile(path.join(DEST, `${group.id}.docs.json`), docsBody)

  return {
    group: group.id,
    label: group.label,
    kind: group.kind,
    files: group.files,
    count: entries.length,
    documented: Object.keys(docs).length,
    indexBytes: Buffer.byteLength(indexBody),
    docsBytes: Buffer.byteLength(docsBody),
    indexSha256: sha256(indexBody),
    docsSha256: sha256(docsBody)
  }
}

const main = async () => {
  let manifest
  try {
    manifest = JSON.parse(await readFile(path.join(SOURCE, 'manifest.json'), 'utf8'))
  } catch {
    throw new Error('no .upstream/manifest.json - run `npm run fetch` first')
  }

  await rm(DEST, { recursive: true, force: true })
  await mkdir(DEST, { recursive: true })

  const built = []
  for (const group of GROUPS) {
    const result = await buildGroup(group)
    built.push(result)
    console.log(
      `  ${result.group.padEnd(24)} ${String(result.count).padStart(5)} entries, ` +
        `${String(result.documented).padStart(5)} documented  ` +
        `index ${(result.indexBytes / 1024).toFixed(0)} KB, docs ${(result.docsBytes / 1024).toFixed(0)} KB`
    )
  }

  const catalogue = {
    source: manifest.source,
    ref: manifest.ref,
    groups: built.map(({ group, label, kind, count, documented }) => ({
      group,
      label,
      kind,
      count,
      documented
    }))
  }
  await writeFile(path.join(DEST, 'index.json'), `${JSON.stringify(catalogue, null, 2)}\n`)

  await writeFile(
    path.join(ROOT, 'provenance.json'),
    `${JSON.stringify(
      {
        source: manifest.source,
        license: manifest.license,
        upstreamRef: manifest.ref,
        generatedBy: 'scripts/build.mjs',
        groups: built
      },
      null,
      2
    )}\n`
  )

  // Typed catalogue for consumers, generated so the group table lives only in
  // scripts/groups.mjs.
  const generated = [
    '// Generated by scripts/build.mjs from scripts/groups.mjs. Do not edit.',
    '// Regenerate with `npm run build`.',
    '',
    'export interface GroupDefinition {',
    '  readonly group: string',
    '  readonly label: string',
    '  /** monaco.languages.CompletionItemKind */',
    '  readonly kind: number',
    '  readonly count: number',
    '  readonly documented: number',
    '}',
    '',
    'export const GROUPS: readonly GroupDefinition[] = [',
    built
      .map(
        (g) =>
          `  { group: ${JSON.stringify(g.group)}, label: ${JSON.stringify(g.label)}, kind: ${g.kind}, count: ${g.count}, documented: ${g.documented} }`
      )
      .join(',\n'),
    ']',
    '',
    `export const UPSTREAM_REF = ${JSON.stringify(manifest.ref)}`,
    `export const UPSTREAM_SOURCE = ${JSON.stringify(manifest.source)}`,
    ''
  ].join('\n')
  await mkdir(path.join(ROOT, 'src'), { recursive: true })
  await writeFile(path.join(ROOT, 'src', 'groups.generated.ts'), generated)
  console.log('written: src/groups.generated.ts')

  const totalIndex = built.reduce((sum, g) => sum + g.indexBytes, 0)
  const totalDocs = built.reduce((sum, g) => sum + g.docsBytes, 0)
  console.log(
    `\n${built.length} groups, ${built.reduce((sum, g) => sum + g.count, 0)} entries` +
      `\nindex total ${(totalIndex / 1024).toFixed(0)} KB, docs total ${(totalDocs / 1024).toFixed(0)} KB`
  )
  console.log('written: data/, provenance.json')

  const stray = (await readdir(DEST)).filter((f) => !f.endsWith('.json'))
  if (stray.length) throw new Error(`unexpected files in data/: ${stray.join(', ')}`)
}

main().catch((error) => {
  console.error(`build failed: ${error.message}`)
  process.exit(1)
})
