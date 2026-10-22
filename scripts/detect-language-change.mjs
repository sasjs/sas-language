/**
 * Decides whether a refresh changed the LANGUAGE DATA, as opposed to only the
 * upstream pin.
 *
 * A scheduled refresh that lands on a new upstream commit whose vocabulary is
 * identical rewrites three files with nothing in them but a new sha:
 * `provenance.json`, `data/index.json` and `src/groups.generated.ts`. Nothing a
 * reviewer can act on changes, and the next run would move the same pin again.
 * The refresh workflow uses this to skip opening such a pull request, and CI
 * uses it to reject one that is opened by hand.
 *
 * The upstream ref is the only field normalised away, in those three files, and
 * it is located by the field that carries it - `upstreamRef`, `ref` or
 * `UPSTREAM_REF` - rather than by a sha-shaped pattern. `provenance.json` also
 * records a sha256 per group, and those digests are compared as they are.
 * Everything else - each group's `index.json` and `docs.json`, and the rest of
 * `groups.generated.ts` - is compared byte for byte, so an entry that appears,
 * disappears, or changes its help text counts as a change.
 *
 * Usage:
 *   node scripts/detect-language-change.mjs [--ref <rev>] [--fail-on-pin-only]
 *
 * `--ref` defaults to HEAD: the worktree against the commit it was built from.
 * `--fail-on-pin-only` exits 1 when the pin moved but no language data did,
 * which is the shape CI rejects on a pull request.
 *
 * Prints `changed=<bool>` and `pinMoved=<bool>`, and appends the same lines to
 * $GITHUB_OUTPUT when that is set, so a workflow can branch on them.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The artefacts a refresh can rewrite, and the ones that carry the upstream ref. */
const ARTEFACTS = ['provenance.json', 'data/index.json', 'src/groups.generated.ts']

/**
 * Reads the upstream ref out of a `provenance.json`, or null when it has none.
 * @param {string} text - the file's contents.
 * @returns {string|null} the sha, lowercased.
 */
export const upstreamRefOf = (text) => {
  try {
    const ref = JSON.parse(text)?.upstreamRef
    return typeof ref === 'string' ? ref.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * The upstream ref a pinned artefact carries, as written. Each of the three
 * stores it in a different place, so it is read from the field rather than
 * guessed from a sha-shaped run of hex - provenance.json also holds sha256
 * digests, and those are data.
 * @param {string} file - the artefact's path, relative to the repo root.
 * @param {string} text - its contents.
 * @returns {string|null} the ref, or null when the file carries none.
 */
export const refIn = (file, text) => {
  try {
    if (file === 'provenance.json') {
      const ref = JSON.parse(text)?.upstreamRef
      return typeof ref === 'string' ? ref : null
    }

    if (file === 'data/index.json') {
      const ref = JSON.parse(text)?.ref
      return typeof ref === 'string' ? ref : null
    }

    if (file === 'src/groups.generated.ts') {
      const match = /UPSTREAM_REF = "([^"]+)"/.exec(text)
      return match ? match[1] : null
    }
  } catch {
    return null
  }

  return null
}

/**
 * Replaces the upstream ref with a placeholder, so that a pin move alone
 * compares equal while every other difference survives.
 * @param {string} file - the artefact's path, relative to the repo root.
 * @param {string} text - its contents.
 * @returns {string} the contents, with its own upstream ref masked.
 */
export const normaliseRefs = (file, text) => {
  const ref = refIn(file, text)

  return ref ? text.split(ref).join('<ref>') : text
}

/**
 * Lists the generated artefacts under a directory, recursively, so an artefact
 * added in a subdirectory is seen as readily as one beside its siblings.
 * @param {string} root - the directory to scan; `data/` is read from it.
 * @returns {string[]} paths relative to `root`, sorted.
 */
export const listArtefacts = (root) => {
  const dataDir = path.join(root, 'data')
  if (!existsSync(dataDir)) return []

  const walk = (dir, prefix) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(dir, entry.name), `${prefix}${entry.name}/`)
        : entry.name.endsWith('.json')
          ? [`data/${prefix}${entry.name}`]
          : []
    )

  return walk(dataDir, '').sort()
}

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })

const atRef = (ref, file) => {
  try {
    // An artefact that the commit does not hold is expected (a new group file),
    // so git's fatal: line is discarded rather than printed on every run.
    return execFileSync('git', ['show', `${ref}:${file}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return null
  }
}

const inWorktree = (file) => {
  const full = path.join(ROOT, file)
  return existsSync(full) ? readFileSync(full, 'utf8') : null
}

/** Every generated artefact the compared commit holds, so a removal is seen. */
const refArtefacts = (ref) =>
  git(['ls-tree', '-r', '--name-only', ref, '--', 'data'])
    .split('\n')
    .filter((name) => name.startsWith('data/') && name.endsWith('.json'))

/**
 * Compares the worktree's artefacts against a commit.
 * @param {string} ref - the commit or ref to compare against.
 * @returns {{changed: boolean, pinMoved: boolean, reasons: string[]}} the verdict.
 */
export const compareWithRef = (ref) => {
  const files = [...new Set([...ARTEFACTS, ...refArtefacts(ref), ...listArtefacts(ROOT)])].sort()
  const reasons = []

  for (const file of files) {
    const before = atRef(ref, file)
    const after = inWorktree(file)
    if (before === null && after === null) continue
    if (normaliseRefs(file, before ?? '') === normaliseRefs(file, after ?? '')) {
      continue
    }

    reasons.push(
      before === null
        ? `${file} was added`
        : after === null
          ? `${file} was removed`
          : `${file} changed`
    )
  }

  const pinMoved =
    upstreamRefOf(atRef(ref, 'provenance.json') ?? '') !==
    upstreamRefOf(inWorktree('provenance.json') ?? '')

  return { changed: reasons.length > 0, pinMoved, reasons }
}

const main = () => {
  const args = process.argv.slice(2)
  const refIndex = args.indexOf('--ref')
  const ref = refIndex === -1 ? 'HEAD' : args[refIndex + 1]
  const failOnPinOnly = args.includes('--fail-on-pin-only')

  const { changed, pinMoved, reasons } = compareWithRef(ref)

  console.log(`compared ${ref} against the working tree`)
  console.log(`upstream pin moved: ${pinMoved}`)
  console.log(`language data changed: ${changed}`)
  reasons.forEach((reason) => console.log(`  - ${reason}`))

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\npinMoved=${pinMoved}\n`)
  }

  if (failOnPinOnly && pinMoved && !changed) {
    console.error(
      '\nThis pull request moves the upstream pin without changing any language data.' +
        '\nThere is nothing here to review, and the next scheduled refresh would move' +
        '\nthe pin again. Re-run `npm run refresh` against the newest upstream, or close it.'
    )
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
