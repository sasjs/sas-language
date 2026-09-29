/**
 * Summarises a refresh as markdown, for the body of the refresh pull request.
 *
 * Compares the provenance committed at HEAD against the one just built, so a
 * reviewer sees which groups gained or lost entries and which upstream commit
 * they came from - rather than a wall of JSON diff.
 *
 * Usage: node scripts/summarise-refresh.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const readHeadProvenance = () => {
  try {
    const raw = execFileSync('git', ['show', 'HEAD:provenance.json'], {
      cwd: ROOT,
      encoding: 'utf8'
    })
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const previous = readHeadProvenance()
const current = JSON.parse(await readFile(path.join(ROOT, 'provenance.json'), 'utf8'))

if (!previous) {
  console.log('## Refresh\n\nFirst publish: no previous provenance to compare against.')
  process.exit(0)
}

const before = new Map(previous.groups.map((g) => [g.group, g]))
const after = new Map(current.groups.map((g) => [g.group, g]))

const lines = ['## Refresh', '']

if (previous.upstreamRef === current.upstreamRef) {
  lines.push(
    `Upstream commit is unchanged (\`${current.upstreamRef}\`) - the regenerated data differs.`,
    ''
  )
} else {
  lines.push(
    `Upstream: \`${previous.upstreamRef}\` -> \`${current.upstreamRef}\``,
    '',
    `https://github.com/sassoftware/vscode-sas-extension/compare/${previous.upstreamRef}...${current.upstreamRef}`,
    ''
  )
}

const changed = []
for (const group of [...new Set([...before.keys(), ...after.keys()])].sort()) {
  const from = before.get(group)
  const to = after.get(group)
  if (!from) {
    changed.push(`| ${group} | new group | ${to.count} |`)
  } else if (!to) {
    changed.push(`| ${group} | **removed** | -${from.count} |`)
  } else if (from.count !== to.count) {
    const delta = to.count - from.count
    changed.push(`| ${group} | ${from.count} -> ${to.count} | ${delta > 0 ? '+' : ''}${delta} |`)
  }
}

const totalBefore = previous.groups.reduce((n, g) => n + g.count, 0)
const totalAfter = current.groups.reduce((n, g) => n + g.count, 0)

if (changed.length === 0) {
  lines.push('No group changed its entry count.', '')
} else {
  lines.push('| group | entries | delta |', '| --- | --- | --- |', ...changed, '')
}

lines.push(`Total entries: ${totalBefore} -> ${totalAfter}`, '')

const undocumented = current.groups.filter((g) => g.documented < g.count)
if (undocumented.length) {
  lines.push(
    'Groups where some entries carry no help text upstream:',
    '',
    ...undocumented.map((g) => `- ${g.group}: ${g.count - g.documented} of ${g.count}`),
    ''
  )
}

console.log(lines.join('\n'))
