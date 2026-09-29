/**
 * SAS language data for editors.
 *
 * The data is resolved from the SAS extension for Visual Studio Code
 * (Apache-2.0) and refreshed on a schedule, so this package owns the vocabulary
 * instead of depending on a language server bundle.
 *
 * Two artefacts per group, split by how a consumer uses them:
 *
 *   data/<group>.index.json   completion index, eager, ~76 KB for all groups
 *   data/<group>.docs.json    hover documentation, lazy, ~1.2 MB in total
 *
 * This entry point holds only pure functions and types, so it adds nothing to a
 * bundle. The data is imported by path, which keeps every group tree-shakeable
 * and lets a bundler emit the documentation as a separate chunk:
 *
 *   import functionsIndex from '@sasjs/sas-language/data/functions.index.json'
 *   import { completionItems, toEntries, docsFor } from '@sasjs/sas-language'
 *
 *   const items = completionItems(functionsIndex)
 *
 * To lazy-load the documentation only when a hover happens:
 *
 *   const docs = await fetch(groupDocsUrl('functions')).then((r) => r.json())
 *   const doc = docsFor(docs, 'abs')
 */
import type { CompletionItem, DocEntry, DocsFile, Entry, IndexFile } from './types.js'

export { GROUPS, UPSTREAM_REF, UPSTREAM_SOURCE } from './groups.generated.js'
export type { GroupDefinition } from './groups.generated.js'
export type { CompletionItem, DocEntry, DocsFile, Entry, EntryTuple, IndexFile } from './types.js'

/** Unpacks a group's index tuples. */
export const toEntries = (index: IndexFile): Entry[] =>
  index.entries.map(([name, type, takesValue]) => ({
    name,
    type,
    takesValue: takesValue === 1
  }))

/** Every word in a group, for a completion provider to match on. */
export const words = (index: IndexFile): string[] => index.entries.map(([name]) => name)

/**
 * Completion items, ready for monaco.languages.registerCompletionItemProvider.
 *
 * Options that take a value insert the trailing equals, so accepting BUFNO
 * leaves the cursor where the value belongs.
 */
export const completionItems = (index: IndexFile): CompletionItem[] =>
  index.entries.map(([name, type, takesValue]) => ({
    label: name,
    kind: index.kind,
    detail: type === undefined ? index.label : `${index.label} (${type})`,
    insertText: takesValue === 1 ? `${name}=` : name
  }))

/** Looks up one word's documentation, case-insensitively. */
export const docsFor = (docs: DocsFile, name: string): DocEntry | undefined => {
  const direct = docs.entries[name]
  if (direct) return direct
  const upper = name.toUpperCase()
  if (docs.entries[upper]) return docs.entries[upper]
  const key = Object.keys(docs.entries).find((k) => k.toUpperCase() === upper)
  return key ? docs.entries[key] : undefined
}

/** The path of a group's completion index inside the package. */
export const groupIndexPath = (group: string): string =>
  `@sasjs/sas-language/data/${group}.index.json`

/** The path of a group's documentation inside the package. */
export const groupDocsPath = (group: string): string =>
  `@sasjs/sas-language/data/${group}.docs.json`
