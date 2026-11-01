#!/usr/bin/env node
/**
 * A strict audit of the RELEASE TOOLCHAIN in release/.
 *
 * Kept separate from the package's own `npm audit` on purpose. The toolchain is
 * not shipped, so its advisories should not gate the package - but it runs in CI
 * with publish credentials, so it must not be invisible either. This reports it
 * in its own scope, by name.
 *
 * Anything not listed in EXEMPT fails the build, and so does an exemption that
 * stops appearing: the list is a claim about the locked tree, and a claim that
 * no longer holds is deleted rather than left to rot. Both are failures because
 * a stale entry is invisible in a passing build, and a list that only warns
 * drifts out of step with the tree it describes.
 *
 * Every entry below sits inside the tree npm 11.21.1 bundles, which
 * @semantic-release/npm resolves from its npm ^11.6.2 range. A bundled tree is
 * a set of files inside npm's own tarball: `overrides` cannot reach it, and the
 * measurement that matters is the newest npm, which 12.2.1 is - it still ships
 * undici 6.29.0, glob 13.0.6 and minimatch 10.2.5, so no bump available to this
 * repo clears them. The undici advisories against the copy resolved OUTSIDE
 * npm's tarball are not exempt, because those were fixable and were fixed:
 * `npm update --package-lock-only` moved undici to 7.30.1 for
 * @semantic-release/github and to 6.29.1 under @actions/http-client.
 *
 * Every exemption carries its own argument - where the affected code sits,
 * whether this repo's release path runs it, and whose input reaches it. An
 * advisory whose input arrives from outside this repo is a risk acceptance
 * rather than a non-issue, and its entry says so rather than claiming
 * unreachability.
 *
 * Uses --package-lock-only, so it needs no install and runs cheaply on a PR.
 *
 * The same script ships in adapter, cli, sas-language, utils and
 * vscode-extension. EXEMPT describes the tree it sits in, so each repo carries
 * its own list: a lockfile bump that clears an entry in one has to land in the
 * others before theirs can shrink.
 *
 * Run with `node release/audit.mjs`.
 */
import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const releaseDir = dirname(fileURLToPath(import.meta.url))

/** An entry for a package inside npm's own bundled tree, with what makes it reachable or not. */
const bundled = (packageAndVersion, reach) =>
  `${packageAndVersion}, bundled inside npm 11.21.1, which @semantic-release/npm resolves from its npm ^11.6.2 range. A bundled tree cannot be reached by \`overrides\`, and npm 12.2.1 - the newest release - still bundles this version, so no bump available to this repo clears it. ${reach}`

/** npm's own copy of a package, reached only through npm's requests, not this repo's code. */
const npmRequestPath = (packageAndVersion) =>
  bundled(
    packageAndVersion,
    "RISK ACCEPTANCE, not unreachability: the affected code is npm's, and the only way this repo reaches it is through npm's own registry requests during publish. The exposure is a stalled or failed publish job; the toolchain is not shipped, so nothing a package consumer runs is affected."
  )

/**
 * Advisories in the release toolchain that cannot be fixed from this repo, and why.
 */
const EXEMPT = new Map([
  [
    'GHSA-3g3m-2fjr-6pw4',
    bundled(
      'glob 13.0.6',
      "NOT REACHABLE HERE: the cancellation bypass needs a caller that aborts a glob mid-walk against an attacker-chosen pattern, and the patterns the release flow matches against come from this repo's own release config (branch globs and releaseRules), not from the commits being matched."
    )
  ],
  [
    'GHSA-g3hv-75wg-m249',
    bundled(
      'minimatch 10.2.5',
      "NOT REACHABLE HERE: the amplification needs an attacker-chosen pattern to expand, and the patterns the release flow matches against come from this repo's own release config (branch globs and releaseRules), not from the commits being matched."
    )
  ],
  ['GHSA-4qv8-2p9j-2685', npmRequestPath('undici 6.29.0')],
  ['GHSA-xjj6-f33q-929c', npmRequestPath('undici 6.29.0')],
  ['GHSA-2m5v-pch6-74hx', npmRequestPath('undici 6.29.0')],
  ['GHSA-qrxm-fqhp-jwvm', npmRequestPath('undici 6.29.0')],
  ['GHSA-9fm3-97px-rjf6', npmRequestPath('undici 6.29.0')],
  [
    'GHSA-rxp7-6hxx-x8q5',
    'ip-address 10.7.2, bundled inside npm 11.21.1, which @semantic-release/npm resolves from its npm ^11.6.2 range. 11.21.1 is the newest 11.x, and the version npm bundles cannot be overridden from here - adding `overrides` for ip-address to release/package.json leaves the lockfile at 10.7.2, which was measured. RISK ACCEPTANCE, not unreachability: the parse runs only on a proxy address that carries an Address6 zone identifier; the exposure is a stall during publish, and that string can arrive from standard npm proxy configuration (`npm_config_proxy`, `HTTPS_PROXY`), so the input path is reachable and the accepted risk is a publish-time stall rather than a package-supplied one. No bump in this repo moves it - forcing npm 12.2.1 inside the toolchain was measured too, and the lockfile still resolves ip-address 10.7.2 through socks 2.8.9. It clears only when npm ships ip-address >= 10.7.4 in its own bundled tree; the advisory then disappears and this entry fails the gate until it is deleted.'
  ]
])

const run = () => {
  try {
    return execFileSync('npm', ['audit', '--package-lock-only', '--json', '--prefix', releaseDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch (error) {
    // npm audit exits non-zero when it finds anything, which is the case we are
    // here to read, so the report on stdout is the payload either way.
    if (error.stdout) return error.stdout
    throw error
  }
}

let report
try {
  report = JSON.parse(run())
} catch {
  console.error('could not read the npm audit report for release/')
  process.exit(1)
}

const ghsaOf = (via) => {
  if (typeof via === 'string') return undefined
  const match = /GHSA-[a-z0-9-]+/i.exec(via?.url ?? '')
  return match ? match[0] : undefined
}

const found = new Map()
for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via ?? []) {
    const id = ghsaOf(via)
    if (!id) continue
    if (!found.has(id)) {
      found.set(id, {
        id,
        title: via.title ?? '',
        severity: via.severity ?? vulnerability.severity,
        packages: new Set()
      })
    }
    found.get(id).packages.add(vulnerability.name)
  }
}

const exempt = [...found.keys()].filter((id) => EXEMPT.has(id))
const failing = [...found.values()].filter((entry) => !EXEMPT.has(entry.id))

console.log(`release toolchain: ${found.size} advisory(s)`)
for (const entry of found.values()) {
  const mark = EXEMPT.has(entry.id) ? 'exempt' : 'FAIL  '
  console.log(
    `  ${mark} ${entry.severity.padEnd(8)} ${entry.id}  ${[...entry.packages].join(', ')}`
  )
  console.log(`         ${entry.title}`)
}

// An exemption that is no longer needed should be deleted, not left to rot.
// Aggregated with the failing gate, so an unexempted advisory is never masked
// by a stale-exemption report (or vice versa).
const stale = [...EXEMPT.keys()].filter((id) => !found.has(id))

if (failing.length) {
  console.error(
    `\n${failing.length} advisory(s) in the release toolchain outside the documented exemptions:`
  )
  for (const entry of failing) {
    console.error(`  ${entry.severity} ${entry.id}  ${entry.title}`)
  }
  console.error(
    '\nThe toolchain is not shipped, but it runs with publish credentials. Fix it,\n' +
      'or add it to EXEMPT in release/audit.mjs with the reason it cannot be fixed.'
  )
}

if (stale.length) {
  console.error('\nexempt advisories that no longer appear, so the exemption can go:')
  for (const id of stale) console.error(`  ${id}  ${EXEMPT.get(id)}`)
}

if (failing.length || stale.length) process.exit(1)

console.log(
  `\nno advisory in the release toolchain outside the documented exemptions` +
    (exempt.length ? ` (${exempt.length} exempt)` : '')
)
