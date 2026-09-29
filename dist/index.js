export { GROUPS, UPSTREAM_REF, UPSTREAM_SOURCE } from './groups.generated.js';
/** Unpacks a group's index tuples. */
export const toEntries = (index) => index.entries.map(([name, type, takesValue]) => ({
    name,
    type,
    takesValue: takesValue === 1
}));
/** Every word in a group, for a completion provider to match on. */
export const words = (index) => index.entries.map(([name]) => name);
/**
 * Completion items, ready for monaco.languages.registerCompletionItemProvider.
 *
 * Options that take a value insert the trailing equals, so accepting BUFNO
 * leaves the cursor where the value belongs.
 */
export const completionItems = (index) => index.entries.map(([name, type, takesValue]) => ({
    label: name,
    kind: index.kind,
    detail: type === undefined ? index.label : `${index.label} (${type})`,
    insertText: takesValue === 1 ? `${name}=` : name
}));
/** Looks up one word's documentation, case-insensitively. */
export const docsFor = (docs, name) => {
    const direct = docs.entries[name];
    if (direct)
        return direct;
    const upper = name.toUpperCase();
    if (docs.entries[upper])
        return docs.entries[upper];
    const key = Object.keys(docs.entries).find((k) => k.toUpperCase() === upper);
    return key ? docs.entries[key] : undefined;
};
/** The path of a group's completion index inside the package. */
export const groupIndexPath = (group) => `@sasjs/sas-language/data/${group}.index.json`;
/** The path of a group's documentation inside the package. */
export const groupDocsPath = (group) => `@sasjs/sas-language/data/${group}.docs.json`;
//# sourceMappingURL=index.js.map