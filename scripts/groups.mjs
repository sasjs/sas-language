/**
 * The upstream files we consume, and how each maps onto a group we publish.
 *
 * One table drives both the fetch and the build, so a group cannot be fetched
 * without being built or built without being fetched.
 *
 * Upstream shape, for every entry:
 *   { "Keywords": { "Keyword": [ { "Name", "Type", "Help": { "#cdata": ... },
 *     "Values"?, "ToolTips"?, "SubOptionsKeywords"?, "Attributes"?,
 *     "States"?, "DisplayType"? } ] } }
 *
 * `kind` maps onto monaco.languages.CompletionItemKind, so a consumer does not
 * have to re-derive it:
 *   1 Function, 6 Variable, 7 Class, 8 Interface, 12 Value, 17 Keyword, 21 Type,
 *   25 Method
 */
export const UPSTREAM = {
  owner: 'sassoftware',
  repo: 'vscode-sas-extension',
  dataDir: 'server/data',
  pubsDataDir: 'server/pubsdata'
}

export const GROUPS = [
  {
    id: 'statements',
    label: 'SAS statement',
    kind: 17,
    files: [
      'SASGlobalStatements.json',
      'SASGlobalProcedureStatements.json',
      'SASDataStepStatements.json'
    ]
  },
  {
    id: 'procNames',
    label: 'SAS procedure',
    kind: 17,
    files: ['SASProcedures.json']
  },
  {
    id: 'functions',
    label: 'SAS function',
    kind: 1,
    files: ['SASFunctions.json']
  },
  {
    id: 'callRoutines',
    label: 'SAS call routine',
    kind: 1,
    files: ['SASCallRoutines.json']
  },
  {
    id: 'macroStatements',
    label: 'SAS macro statement',
    kind: 17,
    files: ['SASMacroStatements.json'],
    // The language server ships a second, differently shaped copy of the macro
    // vocabulary under pubsdata/. It holds names the data files omit, so both
    // are consumed.
    pubsdata: [
      {
        file: 'Statements/en/macro.json',
        type: 'MACRO_STATEMENT'
      }
    ]
  },
  {
    id: 'macroFunctions',
    label: 'SAS macro function',
    kind: 1,
    files: ['SASMacroFunctions.json', 'SASAutocallMacros.json', 'SASARMMacros.json'],
    pubsdata: [
      {
        file: 'Functions/en/macro.json',
        type: 'MACRO_FUNCTION'
      }
    ]
  },
  {
    id: 'formats',
    label: 'SAS format',
    kind: 21,
    files: ['SASFormats.json']
  },
  {
    id: 'informats',
    label: 'SAS informat',
    kind: 21,
    files: ['SASInformats.json']
  },
  {
    id: 'options',
    label: 'SAS data set option',
    kind: 17,
    files: ['SASDataStepOptions.json', 'SASDataSetOptions.json', 'SASDataStepOptions2.json']
  },
  {
    id: 'systemOptions',
    label: 'SAS system option',
    kind: 17,
    files: ['Statements/OPTIONS.json']
  },
  {
    id: 'odsTagsets',
    label: 'ODS destination',
    kind: 17,
    files: ['ODS_Tagsets.json']
  },
  {
    id: 'styleElements',
    label: 'SAS style element',
    kind: 17,
    files: ['StyleElements.json']
  },
  {
    id: 'styleAttributes',
    label: 'SAS style attribute',
    kind: 17,
    files: ['StyleAttributes.json']
  },
  {
    id: 'styleLocations',
    label: 'SAS style location',
    kind: 17,
    files: ['StyleLocations.json']
  },
  {
    id: 'sqlKeywords',
    label: 'PROC SQL keyword',
    kind: 17,
    files: ['SQLKeywords.json']
  },
  {
    id: 'whereOperators',
    label: 'WHERE operator',
    kind: 17,
    files: ['WHERE.json']
  },
  {
    id: 'automaticVariables',
    label: 'SAS automatic variable',
    kind: 6,
    files: ['SASAutoVariables.json']
  },
  {
    id: 'macroDefinitionOptions',
    label: 'SAS macro definition option',
    kind: 17,
    files: ['MacroDefinitionOptions.json']
  },
  {
    id: 'hashMethods',
    label: 'SAS hash method',
    kind: 25,
    files: ['HashPackageMethods.json']
  },
  {
    id: 'statisticsKeywords',
    label: 'SAS statistics keyword',
    kind: 17,
    files: ['StatisticsKeywords.json']
  },
  {
    id: 'ds2Keywords',
    label: 'DS2 keyword',
    kind: 17,
    files: ['DS2Keywords.json']
  },
  {
    id: 'ds2Functions',
    label: 'DS2 function',
    kind: 1,
    files: ['DS2Functions.json']
  }
]

/**
 * Every upstream file the table references, as a path relative to the repo
 * root, so the fetch and the build agree on where a file lives.
 */
export const upstreamFiles = () => [
  ...new Set(
    GROUPS.flatMap((group) => [
      ...group.files.map((file) => `${UPSTREAM.dataDir}/${file}`),
      ...(group.pubsdata ?? []).map(({ file }) => `${UPSTREAM.pubsDataDir}/${file}`)
    ])
  )
]
