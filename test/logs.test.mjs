/**
 * Guards the log parser against the shapes a real SAS log takes: the marker
 * with and without a message code, messages SAS wrapped, markup from an ODS HTML
 * log, and the pointer lines SAS prints under a source statement - which are
 * indented like a wrapped message but are not one.
 *
 * The tests run against the built output, because the package publishes `dist/`
 * and nothing else, and addresses are the whole contract: a host underlines the
 * log with these line and column numbers, so an off-by-one here points a user at
 * the wrong line.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nextIssue, parseLog } from '../dist/logs.js'

/** A log covering what SAS 9 and Viya print for a step that warns, then fails. */
const LOG = [
  '1    data want;',
  '2      set sashelp.class;',
  '3      x = age / 0;',
  '4    run;',
  '',
  'NOTE: There were 19 observations read from the data set SASHELP.CLASS.',
  'WARNING: Division by zero detected at line 3 column 11.',
  'NOTE: The data set WORK.WANT has 19 observations and 5 variables.',
  '',
  '5    proc sql;',
  '6      select x from missing_ds;',
  '7    quit;',
  'ERROR: File WORK.MISSING_DS.DATA does not exist.',
  'ERROR 22-322: Syntax error, expecting one of the following: ;, CANCEL,',
  '              RUN, QUIT.',
  ''
].join('\n')

test('an empty log has no issues', () => {
  assert.deepEqual(parseLog(''), [])
})

test('a log with nothing to report has no issues', () => {
  const log = 'NOTE: There were 19 observations read.\nNOTE: DATA statement used.\n'
  assert.deepEqual(parseLog(log), [])
})

test('ordinary notes and info are not issues', () => {
  const log = [
    'NOTE: There were 19 observations read from the data set SASHELP.CLASS.',
    'NOTE: The data set WORK.WANT has 19 observations and 5 variables.',
    'NOTE: DATA statement used (Total process time):',
    'INFO: The variable y on data set WORK.A will be overwritten.',
    ''
  ].join('\n')

  assert.deepEqual(parseLog(log), [])
})

test('finds the errors and warnings of a real log, in order', () => {
  const issues = parseLog(LOG)

  assert.deepEqual(
    issues.map((issue) => [issue.line, issue.severity]),
    [
      [6, 'warning'],
      [12, 'error'],
      [13, 'error']
    ]
  )
})

test('reports the message SAS prints after the marker', () => {
  const [warning] = parseLog(LOG)

  assert.equal(warning.message, 'Division by zero detected at line 3 column 11.')
})

test('reports the message code separately from the message', () => {
  const issues = parseLog(LOG)

  assert.equal(issues[1].code, undefined)
  assert.equal(issues[2].code, '22-322')
})

test('folds the lines SAS wrapped into the message they belong to', () => {
  const syntaxError = parseLog(LOG)[2]

  assert.equal(syntaxError.line, 13)
  assert.equal(syntaxError.endLine, 14)
  assert.equal(
    syntaxError.message,
    'Syntax error, expecting one of the following: ;, CANCEL, RUN, QUIT.'
  )
})

test('addresses the marker line so a host can underline it', () => {
  const [, error] = parseLog(LOG)

  assert.equal(error.column, 0)
  assert.equal(error.endColumn, 'ERROR: File WORK.MISSING_DS.DATA does not exist.'.length)
})

test('does not match a marker that does not start the line', () => {
  const log = ' a data step printed ERROR: this is text in a data set\n'
  assert.deepEqual(parseLog(log), [])
})

test('does not absorb the pointer lines SAS prints under a source statement', () => {
  const log = [
    '14       x = age / 0;',
    '                ----',
    '                22',
    'ERROR: Division by zero detected.',
    ''
  ].join('\n')
  const [error] = parseLog(log)

  assert.equal(error.endLine, 3)
  assert.equal(error.message, 'Division by zero detected.')
})

test('skips the markup of an ODS HTML log and strips it from the message', () => {
  const log = '<font color="red">ERROR: File WORK.X.DATA does not exist.</font><br>\n'
  const [error] = parseLog(log)

  assert.equal(error.severity, 'error')
  assert.equal(error.column, '<font color="red">'.length)
  assert.equal(error.message, 'File WORK.X.DATA does not exist.')
})

test('reads a log written with CRLF line endings', () => {
  const issues = parseLog('NOTE: one\r\nERROR: two\r\nWARNING: three\r\n')

  assert.deepEqual(
    issues.map((issue) => [issue.line, issue.severity, issue.message]),
    [
      [1, 'error', 'two'],
      [2, 'warning', 'three']
    ]
  )
})

test('nextIssue steps forward from the cursor and wraps at the end', () => {
  const issues = parseLog(LOG)

  assert.equal(nextIssue(issues, -1)?.line, 6)
  assert.equal(nextIssue(issues, 6)?.line, 12)
  assert.equal(nextIssue(issues, 13)?.line, 6)
})

test('previousIssue steps back from the cursor and wraps at the start', () => {
  const issues = parseLog(LOG)

  assert.equal(nextIssue(issues, 6, 'previous')?.line, 13)
  assert.equal(nextIssue(issues, 98, 'previous')?.line, 13)
  assert.equal(nextIssue(issues, 13, 'previous')?.line, 12)
})

test('navigation over a log with no issues yields nothing', () => {
  assert.equal(nextIssue([], 0), undefined)
  assert.equal(nextIssue([], 0, 'previous'), undefined)
})

/**
 * A corpus drawn from published SAS log-checking tools, so the parser is held
 * against lines that appear in the literature rather than lines written to suit
 * it. The ERROR strings and the notable-NOTE vocabulary are taken from
 * "You've Got E-Mail: Automatic Log Checking via E-Mail Notification"
 * (SUGI 31, paper 128-31), "Check Please: An Automated Approach to Log
 * Checking" (MWSUG 2017, paper TT02), "Log Checks Made Easy" (SAS Global Forum
 * 2012, paper 042-2012) and the log viewer of the SAS extension for VS Code.
 */
const PUBLISHED = [
  'ERROR: DDE session not ready.',
  'ERROR: Physical file does not exist, Data.xls',
  'ERROR: File not found.',
  'WARNING: Apparent symbolic reference MACNAME not resolved.',
  'NOTE: MERGE statement has more than one data set with repeats of BY values.',
  'NOTE: Invalid data for age in line 42 3-5.',
  'NOTE: Variable x is uninitialized.',
  'NOTE: At least one W.D format was too small for the number to be printed.',
  'INFO: The variable y on data set WORK.A will be overwritten by data set WORK.B.',
  'ERROR: The following columns were not found in the contributing tables: amount.',
  'WARNING: The data set WORK.OUT may be incomplete. When this step was stopped there were 0 observations.',
  ''
].join('\n')

test('reports the errors, warnings and notable notes of a published corpus', () => {
  const issues = parseLog(PUBLISHED)

  assert.deepEqual(
    issues.map((issue) => [issue.line, issue.severity, issue.message]),
    [
      [0, 'error', 'DDE session not ready.'],
      [1, 'error', 'Physical file does not exist, Data.xls'],
      [2, 'error', 'File not found.'],
      [3, 'warning', 'Apparent symbolic reference MACNAME not resolved.'],
      [4, 'note', 'MERGE statement has more than one data set with repeats of BY values.'],
      [5, 'note', 'Invalid data for age in line 42 3-5.'],
      [6, 'note', 'Variable x is uninitialized.'],
      [7, 'note', 'At least one W.D format was too small for the number to be printed.'],
      [9, 'error', 'The following columns were not found in the contributing tables: amount.'],
      [
        10,
        'warning',
        'The data set WORK.OUT may be incomplete. When this step was stopped there were 0 observations.'
      ]
    ]
  )
})

test('leaves the ordinary notes of that corpus alone', () => {
  // The INFO line in the fixture is the one a reader can ignore: MSGLEVEL=I
  // reports overwritten variables as information, and no keyword matches it.
  const issues = parseLog(PUBLISHED)

  assert.equal(
    issues.some((issue) => issue.message.includes('will be overwritten')),
    false
  )
})

test('reports each notable note as a note, not as a warning', () => {
  const log = [
    'NOTE: Missing values were generated as a result of performing an operation on missing values.',
    'NOTE: Division by zero detected at line 11 column 5.',
    'NOTE: Mathematical operations could not be performed at the following places.',
    'NOTE: Character values have been converted to numeric values.',
    'NOTE: The meaning of an identifier after a quoted string might change.',
    'NOTE: Unreferenced label defined: y.',
    'NOTE: WHERE clause has been replaced.',
    'NOTE: DATA STEP stopped due to looping.',
    'NOTE: The file WORK.X was not found.',
    'NOTE: SAS went to a new line when INPUT statement reached past the end of a line.',
    'NOTE: LOST CARD.',
    'NOTE: Statement not executed due to NOEXEC option.',
    'NOTE: A CASE expression has no ELSE clause.',
    'NOTE: Some of the tick values have been thinned.',
    'NOTE: A GROUP BY clause has been discarded because neither the SELECT clause',
    'NOTE: Processing on disk occurred during summarization.',
    'NOTE: The log axis cannot support zero or negative values.',
    'NOTE: One or more lines were truncated.',
    'NOTE: The SAS System stopped processing this step because of errors.',
    ''
  ].join('\n')

  const issues = parseLog(log)

  assert.equal(issues.length, 19)
  assert.deepEqual(
    issues.map((issue) => issue.severity),
    new Array(19).fill('note')
  )
})

test('finds a notable note whose keyword lands on a wrapped line', () => {
  const log = [
    'NOTE: Character values have been converted',
    '      to numeric values at the places given by: (Line):(Column).',
    ''
  ].join('\n')

  const [note] = parseLog(log)

  assert.equal(note.severity, 'note')
  assert.equal(note.line, 0)
  assert.equal(note.endLine, 1)
  assert.equal(
    note.message,
    'Character values have been converted to numeric values at the places given by: (Line):(Column).'
  )
})

test('does not report a marker quoted inside another message', () => {
  const log = 'NOTE: The previous step wrote ERROR: File not found. - see the documentation.\n'

  assert.deepEqual(parseLog(log), [])
})
