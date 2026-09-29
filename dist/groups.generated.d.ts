export interface GroupDefinition {
    readonly group: string;
    readonly label: string;
    /** monaco.languages.CompletionItemKind */
    readonly kind: number;
    readonly count: number;
    readonly documented: number;
}
export declare const GROUPS: readonly GroupDefinition[];
export declare const UPSTREAM_REF = "c6092de6cae08fd3f2ab5db543549c9f5685c27c";
export declare const UPSTREAM_SOURCE = "https://github.com/sassoftware/vscode-sas-extension";
//# sourceMappingURL=groups.generated.d.ts.map