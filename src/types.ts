/**
 * The shapes the generated data files use.
 *
 * The completion index is stored as tuples rather than objects because it is
 * loaded eagerly by a completion provider: `[name, type, takesValue?]` keeps
 * the eager payload at roughly a twentieth of the documentation it sits beside.
 * Use `toEntries` rather than reading the tuples directly.
 */

/** One entry in a group's index, as stored. */
export type EntryTuple = readonly [name: string, type: string, takesValue?: 1]

/** A group's completion index. */
export interface IndexFile {
  group: string
  label: string
  /** monaco.languages.CompletionItemKind */
  kind: number
  count: number
  entries: readonly EntryTuple[]
}

/** One entry's documentation, as stored. */
export interface DocEntry {
  /** The upstream help text, which carries the syntax line and the description. */
  help: string
  values?: Record<string, string>
  tooltips?: Record<string, string>
  subOptions?: string
  attributes?: Record<string, string>
  states?: Record<string, string>
}

/** A group's documentation, loaded on demand. */
export interface DocsFile {
  group: string
  count: number
  entries: Record<string, DocEntry>
}

/** An index entry with its tuple unpacked. */
export interface Entry {
  name: string
  type: string
  /** True when the word takes a value, e.g. the option BUFNO. */
  takesValue: boolean
}

/** The minimum a completion provider needs, independent of any editor. */
export interface CompletionItem {
  label: string
  kind: number
  detail: string
  insertText: string
}
