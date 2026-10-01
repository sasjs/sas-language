/**
 * SAS macro names that ship with SAS but that the upstream extension data
 * omits, keyed by group.
 *
 * Upstream is the source of truth and is consumed first, so an entry here only
 * takes effect while upstream still lacks it: the moment SAS adds the name, the
 * upstream row wins and this list can shrink. The supplement exists because the
 * two upstream copies of the macro vocabulary are each incomplete - neither
 * lists `%INDEXC`, `%TRANWRD` or `%TRIMN`, and neither lists the `%BY`, `%TO`
 * or `%INC` keywords - while a linter needs the whole set to tell a
 * SAS-provided macro from an undeclared one.
 *
 * Names and types are taken from the SAS Macro Language Reference. The
 * `%QKLOWCASE` entry repairs `%QKLOWCAS`, which is how upstream spells it in
 * both `SASMacroFunctions.json` and `SASAutocallMacros.json`.
 */
export const SUPPLEMENTS = {
  macroStatements: [
    // The keywords of the %DO statement, and the %INCLUDE abbreviation.
    ['%BY', 'MACRO_KEYWORD'],
    ['%TO', 'MACRO_KEYWORD'],
    ['%INC', 'VALIDANYWHERE']
  ],
  macroFunctions: [
    ['%INDEXC', 'MACRO_FUNCTION'],
    ['%INDEXW', 'MACRO_FUNCTION'],
    ['%QBQUOTE', 'MACRO_FUNCTION'],
    ['%QDEQUOTE', 'MACRO_FUNCTION'],
    ['%QINDEX', 'MACRO_FUNCTION'],
    ['%QINDEXC', 'MACRO_FUNCTION'],
    ['%QINDEXW', 'MACRO_FUNCTION'],
    ['%TRANSLATE', 'MACRO_FUNCTION'],
    ['%TRANWRD', 'MACRO_FUNCTION'],
    ['%TRIMN', 'MACRO_FUNCTION'],
    // Upstream ships this name truncated to %QKLOWCAS.
    ['%QKLOWCASE', 'MACRO_FUNCTION']
  ]
}
