# SAS language support for editors

`@sasjs/sas-language` provides SAS language support in two forms, from one
upstream source and one pinned commit:

    data/      the vocabulary: completions, hover documentation, signatures
    server/    the SAS language server, compiled from upstream source

Both are resolved from the [SAS extension for Visual Studio Code](https://github.com/sassoftware/vscode-sas-extension)
and refreshed on a schedule, so this package owns the language support rather than
depending on an installed editor extension.

The data is small, has no runtime dependencies and uses no Node built-ins, so it
runs unchanged in a browser, in Node and in an editor extension. The server is the
full language service - semantic tokens, diagnostics, context-aware completions -
and is what an editor that wants a real parser loads.

## Why this exists

An editor needs to know SAS. The alternatives were to depend on an installed
extension for the data, or to hand-maintain keyword lists. This package takes the
authoritative data, transforms it into something cheap to load, and keeps it
current with a scheduled job.

The server is here for the same reason. Upstream publishes no built artifact - its
`dist/` is ignored and it has no release assets - so anyone wanting the language
service had to build it from source themselves. This package compiles it from the
pinned commit and ships the result.

## Install

```
npm install @sasjs/sas-language
```

The registry tarball ships the compiled output, so nothing is built on install. It
is roughly 6 MB compressed, carrying both the data and both server builds.

A git install also works, but needs lifecycle scripts enabled, because the build
output is not committed and `prepare` compiles it. A git install does not build the
server, which takes a few minutes - run `npm run build:server` for that.

```
npm install git+https://github.com/sasjs/sas-language.git#<commit>
```

Note that npm rewrites a github git dependency to an ssh URL in the lockfile,
which a CI without an ssh key cannot fetch, so prefer the registry.

## Use

The data is split so that a completion provider loads something small and hover
text is fetched only when the user actually hovers.

    data/<group>.index.json    completion index, ~76 KB across all groups
    data/<group>.docs.json     hover documentation, ~1.2 MB across all groups

```ts
import functionsIndex from '@sasjs/sas-language/data/functions.index.json'
import { completionItems, docsFor, groupDocsPath } from '@sasjs/sas-language'

// Eager: completion items, ready for monaco.languages.registerCompletionItemProvider
const items = completionItems(functionsIndex)
// [{ label: 'ABS', kind: 1, detail: 'SAS function (SAS_FUNCTION)', insertText: 'ABS' }, ...]

// Lazy: the documentation only when a hover happens
const docs = await fetch(groupDocsPath('functions')).then((r) => r.json())
const doc = docsFor(docs, 'abs')
// { help: 'Returns the absolute value. ...' }
```

Every group is a separate path, so a bundler emits only the groups you import and
the documentation as its own chunk.

## The language server

Two builds ship, because the two consumers run in different places:

    server/browser/server.js   webworker build, for an editor in a browser
    server/node/server.js      node build, run over IPC by a VS Code extension

The node build is a fraction of the browser build, because the browser bundle
inlines the Python stubs that the node build reads from disk.

The server has to exist as a file on disk - a VS Code extension spawns it as a
child process rather than importing it - so copy it out of the package at build
time:

```ts
const serverModule = context.asAbsolutePath('server/node/server.js')

const serverOptions: ServerOptions = {
  run: { module: serverModule, transport: TransportKind.ipc }
}
const clientOptions: LanguageClientOptions = {
  documentSelector: [{ language: 'sas' }]
}

new LanguageClient('sas-lsp', 'SAS', serverOptions, clientOptions).start()
```

`server/provenance.json` records the commit both builds came from. It also
records `byteReproducible: false`: the upstream loader inlines the Python stubs in
filesystem order rather than sorting them, so the artifact is deterministic in
content but not in bytes.

### Groups

`GROUPS` lists every group with its label, completion kind and entry count.
Group names are stable; entries are refreshed from upstream.

| group                                                | contents                                   |
| ---------------------------------------------------- | ------------------------------------------ |
| `statements`                                         | global, procedure and DATA step statements |
| `procNames`                                          | procedures                                 |
| `functions`                                          | SAS functions                              |
| `callRoutines`                                       | CALL routines                              |
| `macroStatements`                                    | macro statements                           |
| `macroFunctions`                                     | macro functions, autocall and ARM macros   |
| `formats`, `informats`                               | formats and informats                      |
| `options`                                            | data set options                           |
| `systemOptions`                                      | system options                             |
| `odsTagsets`                                         | ODS destinations                           |
| `styleElements`, `styleAttributes`, `styleLocations` | ODS style parts                            |
| `sqlKeywords`                                        | PROC SQL keywords                          |
| `whereOperators`                                     | WHERE operators                            |
| `automaticVariables`                                 | automatic variables                        |
| `macroDefinitionOptions`                             | macro definition options                   |
| `hashMethods`                                        | hash package methods                       |
| `statisticsKeywords`                                 | statistics keywords                        |
| `ds2Keywords`, `ds2Functions`                        | DS2 language                               |

### API

| export                            | purpose                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `GROUPS`                          | the group catalogue: name, label, completion kind, counts      |
| `toEntries(index)`                | unpacks a group's index into `{ name, type, takesValue }`      |
| `words(index)`                    | every word in a group, for matching                            |
| `completionItems(index)`          | completion items, inserting the trailing `=` for value options |
| `docsFor(docs, name)`             | one word's documentation, case-insensitively                   |
| `groupIndexPath(group)`           | the package path of a group's index                            |
| `groupDocsPath(group)`            | the package path of a group's documentation                    |
| `UPSTREAM_REF`, `UPSTREAM_SOURCE` | which upstream commit the data came from                       |

## How the data is refreshed

`npm run refresh` fetches the upstream files at a pinned commit and rebuilds. The
scheduled workflow in `.github/workflows/refresh.yml` runs this weekly and opens a
pull request when the data changes, so an upstream change is reviewed rather than
absorbed silently.

`provenance.json` records the upstream repository, the resolved commit, and a
sha256 per generated file. Tests assert the published data matches those hashes,
which means hand-edited data or a stale `.upstream/` fails the build.

The build fails when upstream changes the shape of a file, rather than publishing
a quietly empty group. That is deliberate: a shape change should break a build,
not degrade somebody's editor.

    npm run fetch     # download at the latest upstream commit
    npm run build     # transform into data/ and compile
    npm test          # validate the data and the transforms

The server is compiled from the same pin, by `npm run build:server`. That step is
heavier - it fetches upstream at the commit, installs its dependencies and runs its
build - so it is deliberately not part of `npm run build`. It runs in CI when the
build or the pin changes, weekly against the latest upstream, and before any
publish.

## Repository hardening

`.npmrc` installs without running lifecycle scripts, writes exact versions, enforces the `engines` field, and keeps the lockfile honest.

`.git-hooks/` carries the org's checks: a `pre-commit` that scans the staged diff with gitleaks and refuses a commit over 2MB, and a `commit-msg` that enforces Conventional Commits. `npm run prepare` wires them up, but `.npmrc` sets `ignore-scripts=true`, which suppresses it - so after a fresh clone:

```
git config core.hooksPath ./.git-hooks
```

A hook is best-effort, so CI enforces the same things from the other side: a full-history `gitleaks detect`, `npm audit --omit=dev --audit-level=low` for the shipped surface, and `npm run audit` for everything else, dev dependencies included. That last one fails on any advisory outside two documented exemptions - see `scripts/audit.mjs` - so a new advisory anywhere else cannot land quietly.

## Releasing

`.github/workflows/publish.yml` publishes on every push to `main`.

Versioning is semantic-release's job: it reads the conventional commits since the
last tag, bumps the version, tags the release and writes the release notes.
Publishing is a separate step, and it uses the npm trusted publisher, so no token
is stored anywhere.

Setup, once: on npmjs.com, add a trusted publisher for `@sasjs/sas-language` -
repository `sasjs/sas-language`, workflow `publish.yml`, environment blank.

semantic-release is configured **not** to push to `main`: `@semantic-release/git`
is deliberately absent, so the version commit is never made and nothing needs to
bypass branch protection. The release notes and the semantic versioning are
unaffected - `@semantic-release/github` still publishes the grouped notes as the
release body, and `@semantic-release/commit-analyzer` still maps `fix:` to a
patch, `feat:` to a minor and a breaking change to a major. The one consequence
is that `package.json` on `main` keeps the last committed version rather than the
released one.

Which commits cut a release follows the usual convention: `fix:` and `feat:` on
`main` do, `chore:` and `ci:` do not. The refresh workflow opens a pull request,
so merging it with a `fix:` or `feat:` subject is what cuts the next release.

The publish step asks the registry first, so a push that produces no release
reports that the version is already published and stays green, rather than
failing with E403. When there is something to publish, it builds both the compiled
API and the server, and refuses to publish if any artifact is missing.

The workflow installs npm 11 before installing anything, because the trusted
publisher needs 11.5.1 or later and a release should not adopt a new npm major on
its own. `scripts/build-server.mjs` patches the upstream sub-build dispatch so the
server builds on npm 11 and npm 12 alike; the pin keeps the release on the older
of the two until the move is deliberate.

## Licence

The package is MIT. Both the data and the compiled server come from the SAS
extension for Visual Studio Code, which is Apache-2.0. The server also carries
pyright (MIT), typeshed (Apache-2.0), buffer (MIT) and ieee754 (BSD-3-Clause); the
licence texts travel with it in `server/`. See `NOTICE`.
