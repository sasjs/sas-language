/**
 * The shapes the generated data files use.
 *
 * The completion index is stored as tuples rather than objects because it is
 * loaded eagerly by a completion provider: `[name, type, takesValue?]` keeps
 * the eager payload at roughly a twentieth of the documentation it sits beside.
 * Use `toEntries` rather than reading the tuples directly.
 */
export {};
//# sourceMappingURL=types.js.map