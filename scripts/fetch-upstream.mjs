/**
 * Downloads the SAS language data files from the SAS extension for VS Code.
 *
 * Writes them under .upstream/, mirroring their repo path, and records exactly
 * what was fetched in .upstream/manifest.json: the resolved commit, and a
 * sha256 and byte count per file. The manifest is what makes a refresh
 * reviewable - it shows which upstream commit produced a data change, rather
 * than only that a file moved.
 *
 * Usage:
 *   node scripts/fetch-upstream.mjs                  # latest commit on main
 *   node scripts/fetch-upstream.mjs --ref <sha|tag>  # a pinned ref
 *   node scripts/fetch-upstream.mjs --from <dir>     # a local clone (offline)
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { GROUPS, UPSTREAM, upstreamFiles } from './groups.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEST = path.join(ROOT, '.upstream')

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

const resolveRef = async (requested) => {
  if (requested) return requested
  const response = await fetch(
    `https://api.github.com/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/commits/main`,
    { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'sasjs-language' } }
  )
  if (!response.ok) {
    throw new Error(`cannot resolve upstream HEAD: ${response.status} ${response.statusText}`)
  }
  const body = await response.json()
  return body.sha
}

const download = async (file, ref) => {
  const url = `https://raw.githubusercontent.com/${UPSTREAM.owner}/${UPSTREAM.repo}/${ref}/${file}`
  const response = await fetch(url, { headers: { 'User-Agent': 'sasjs-language' } })
  if (!response.ok) {
    // A renamed or removed upstream file must fail the refresh, not silently
    // shrink the package.
    throw new Error(`cannot fetch ${file} at ${ref}: ${response.status} ${response.statusText}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

const main = async () => {
  const from = arg('from')
  const requested = arg('ref')
  const files = upstreamFiles()

  await rm(DEST, { recursive: true, force: true })

  let ref
  let read
  if (from) {
    ref = requested ?? 'local'
    read = (file) => readFile(path.join(from, file))
  } else {
    ref = await resolveRef(requested)
    read = (file) => download(file, ref)
  }

  console.log(
    `fetching ${files.length} files from ${UPSTREAM.owner}/${UPSTREAM.repo}@${ref.slice(0, 10)}`
  )

  const manifest = {}
  let bytes = 0

  for (const file of files) {
    const buffer = await read(file)
    const target = path.join(DEST, file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, buffer)
    manifest[file] = { sha256: sha256(buffer), bytes: buffer.length }
    bytes += buffer.length
    console.log(
      `  ${file.padEnd(34)} ${String(buffer.length).padStart(8)} bytes  ${sha256(buffer).slice(0, 12)}`
    )
  }

  await writeFile(
    path.join(DEST, 'manifest.json'),
    `${JSON.stringify(
      {
        source: `https://github.com/${UPSTREAM.owner}/${UPSTREAM.repo}`,
        license: 'Apache-2.0',
        dataDir: UPSTREAM.dataDir,
        ref,
        files: manifest
      },
      null,
      2
    )}\n`
  )

  const groups = GROUPS.length
  console.log(`\n${files.length} files, ${(bytes / 1e6).toFixed(1)} MB, feeding ${groups} groups`)
  console.log(`written: ${path.relative(ROOT, DEST)}/manifest.json`)
}

main().catch((error) => {
  console.error(`fetch failed: ${error.message}`)
  process.exit(1)
})
