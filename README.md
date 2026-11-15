# SAS language support for editors

`@sasjs/sas-language` provides SAS language support in two forms:

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
is 12 MB compressed and 5,214 files, carrying the data and both language-server
builds.

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

## Formatting

`./format` exposes the formatter the server uses, without running the server - the reprint as a call, for hosts that cannot speak LSP to it, such as a CLI in CI. It is a node API, reading the vocabulary from disk; a browser editor keeps the webworker server it already runs, and a browser product asks a node host instead.

```ts
import { formatText } from '@sasjs/sas-language/format'

const formatted = await formatText(source, { tabWidth: 2, useTabs: false })
```

It lexes with the same vocabulary the server does, so it needs that data tree on disk. `dataRoot` defaults to the staged `server/node` directory, which a registry install already has; pass it to read the vocabulary from somewhere else. It applies to that call alone: the hook the lexer reads through is process-wide, so each call sets it before lexing and restores it afterwards. The root must be the complete tree: with the procedure files missing, a DATA step still formats and a PROC step throws, naming the file it could not read. The vocabulary is cached for the life of the process, so a root decides where a file is read the first time it is needed.

Keyword case is preserved rather than normalised - the printer has no casing option - so a house style is applied by whatever rules layer sits above this one.

## The language server

Two builds ship, because the two consumers run in different places:

    server/browser/server.js            webworker build, for an editor in a browser
    server/node/dist/node/server.js     node build, run over IPC by a VS Code extension

The browser build is a single file: it inlines everything. The node build is a
directory tree, because it reads parts of itself from disk at runtime - the
formatter's impl/ modules, the Python typeshed stubs, the SAS documentation
tree and the localised message bundles. The staged layout mirrors the depth the
upstream build produces (server/node/dist/node/), so every relative path the
bundle computes resolves inside the package.

The server has to exist as a file on disk - a VS Code extension spawns it as a
child process rather than importing it - so copy the whole node tree out of the
package at build time, preserving its internal layout:

```ts
const serverModule = context.asAbsolutePath('out/server/dist/node/server.js')

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

A hook is best-effort, so CI enforces the same things from the other side: a full-history `gitleaks detect` and `npm audit --audit-level=low` across every dependency, dev included. The package has no runtime dependencies, so any advisory at all is a real one.

## Releasing

`.github/workflows/publish.yml` publishes on every push to `main`, and the version comes from the conventional commits since the last tag - `fix:` and `feat:` on `main` release, `chore:` and `ci:` do not.

[@sasjs/release](https://github.com/sasjs/release) cuts the tag and a draft release over the API: nothing is pushed to `main`, no version commit is made, and no branch protection is bypassed. `--prepare-publish` then stamps the tag's version into `package.json` and refuses a tag that is not an ancestor of `main`, and the tarball is published with the npm trusted publisher, so no token is stored anywhere. The release is un-drafted last, so a version is never advertised before its artifact exists.

Between the build and the publish sit the gates that decide whether a release is real: `npm run build:ship` builds everything in one command, `npm test` runs afterwards so the suites that need those artifacts actually execute, and `npm run verify:pack` derives every path the export map promises and refuses to publish a tarball missing one. `package.json` on `main` keeps its committed version - the tag records what was released.

Setup, once: on npmjs.com, add a trusted publisher for `@sasjs/sas-language` - repository `sasjs/sas-language`, workflow `publish.yml`, environment blank. The filename is load-bearing: the trusted publisher and the provenance attestation both name it.

## Licence

The package is MIT. Both the data and the compiled server come from the SAS
extension for Visual Studio Code, which is Apache-2.0. The server also carries
pyright (MIT), typeshed (Apache-2.0), buffer (MIT) and ieee754 (BSD-3-Clause); the
licence texts travel with it in `server/`. See `NOTICE`.
