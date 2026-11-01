/**
 * SAS log parsing.
 *
 * A SAS log is a stream of statements and messages, and only the messages
 * matter to a reader looking for trouble: everything SAS prints at the start of
 * a line as `ERROR:` or `WARNING:`. This module finds those messages and
 * reports where they are, as line and column indexes into the text it was
 * given, so a host can underline them without re-scanning the log and without
 * rewriting it. Nothing here touches the log: the caller renders from the
 * issue list, which is what lets one log be shown in an editor, in a browser
 * panel and in a report from the same parse.
 *
 * What is recognised:
 *
 *   ERROR: Libref X is not assigned.
 *   ERROR 22-322: Syntax error, expecting one of the following: ;, CANCEL,
 *                 RUN, QUIT.
 *   WARNING 1-322: Assuming the symbol Y was misspelled.
 *
 * The numeric code between the marker and the colon is SAS's own message
 * identifier and is reported separately, so a host can group by it.
 *
 * NOTE and INFO lines are not issues: a log carries thousands of them and they
 * are not what a reader is looking for. Lines SAS wrapped are folded into the
 * message they belong to, so one problem is one issue rather than one issue per
 * wrapped line. Lines that merely contain the word ERROR are not matched - the
 * marker has to start the line, which keeps a print of a data set, or a message
 * quoting another log, out of the results.
 *
 * ODS HTML logs wrap every line in markup. A tag sequence before the marker is
 * skipped and tags are stripped from the reported message, so the same parse
 * serves a plain log and an HTML one. The line and column indexes stay those of
 * the text as supplied, because they are what the caller needs to address.
 */

/** The severities a log issue can carry. Notes and info are not issues. */
export type LogSeverity = 'error' | 'warning'

/** One ERROR or WARNING in a SAS log, addressed in the text it was parsed from. */
export interface LogIssue {
  /** Zero-based index of the line carrying the marker. */
  line: number
  /** Zero-based index of the last line SAS wrapped into this message. */
  endLine: number
  /** Zero-based column where the marker starts on `line`. */
  column: number
  /** Zero-based column one past the end of `line`, for underlining it. */
  endColumn: number
  /** The marker that introduced the issue. */
  severity: LogSeverity
  /** SAS's message identifier, e.g. `22-322` for `ERROR 22-322:`. */
  code?: string
  /** The message text, with wrapped lines joined and markup stripped. */
  message: string
}

/** Direction of travel for {@link nextIssue}. */
export type IssueDirection = 'next' | 'previous'

/**
 * `ERROR` or `WARNING` at the start of a line, optionally preceded by the tags
 * of an HTML log, optionally followed by SAS's message identifier, then a colon.
 * The prefix is captured so the marker's column is exact even when tags lead it.
 */
const MARKER = /^((?:<[^>]*>)*\s*)(ERROR|WARNING)(?:\s+(\d+-\d+))?:[ \t]?(.*)$/i

/** How many wrapped lines one message may absorb, so a malformed log cannot run away. */
const MAX_WRAPPED_LINES = 10

/** A line SAS wrapped: indented, and not one of the pointer lines it prints under source. */
const isWrappedLine = (line: string): boolean =>
  /^\s+\S/.test(line) && !/^\s*[-_]+\s*$/.test(line) && !/^\s*\d+\s*$/.test(line)

/** Removes markup and collapses the whitespace a wrapped message carries. */
const clean = (text: string): string =>
  text
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Finds every ERROR and WARNING in a SAS log.
 *
 * The issue list is in log order. `line` and `column` address the text as
 * supplied, so a caller can offset a decoration or a diagnostic by them
 * directly.
 */
export const parseLog = (text: string): LogIssue[] => {
  if (!text) {
    return []
  }

  const lines = text.split(/\r?\n/)
  const issues: LogIssue[] = []

  for (let line = 0; line < lines.length; line++) {
    const match = MARKER.exec(lines[line])

    if (!match) {
      continue
    }

    const parts = [clean(match[4] ?? '')]
    let endLine = line
    let wrapped = 0

    while (
      wrapped < MAX_WRAPPED_LINES &&
      endLine + 1 < lines.length &&
      isWrappedLine(lines[endLine + 1])
    ) {
      endLine++
      wrapped++
      parts.push(clean(lines[endLine]))
    }

    const code = match[3]

    issues.push({
      line,
      endLine,
      column: match[1].length,
      endColumn: lines[line].length,
      severity: match[2].toLowerCase() as LogSeverity,
      ...(code ? { code } : {}),
      message: parts.filter((part) => part !== '').join(' ')
    })

    line = endLine
  }

  return issues
}

/**
 * The issue after (or before) a given line, wrapping around, which is the
 * behaviour both a "next problem" button and a "previous problem" button need.
 *
 * A line of -1 starts at the beginning, and a line past the end starts again
 * from the beginning, so a caller does not have to special-case either end.
 * Returns undefined only when the log holds no issues.
 */
export const nextIssue = (
  issues: LogIssue[],
  line: number,
  direction: IssueDirection = 'next'
): LogIssue | undefined => {
  if (issues.length === 0) {
    return undefined
  }

  if (direction === 'next') {
    return issues.find((issue) => issue.line > line) ?? issues[0]
  }

  for (let index = issues.length - 1; index >= 0; index--) {
    if (issues[index].line < line) {
      return issues[index]
    }
  }

  return issues[issues.length - 1]
}
