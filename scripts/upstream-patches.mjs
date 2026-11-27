/**
 * Patches applied to the fetched upstream tree.
 *
 * `.upstream` is a checkout of sassoftware/vscode-sas-extension at the commit in
 * provenance.json, not a fork, so a defect in it is corrected where it lands -
 * here - rather than by asking every consumer to work around it. Two rules make
 * that safe: a patch is an exact-string replacement that throws when its anchor
 * has gone, so an upstream change fails the build instead of shipping a bundle
 * that silently lost the patch; and applying one twice is a no-op, because the
 * format bundles call this as well as the server build.
 *
 * Each entry carries the reason it exists, because the patch is the only place
 * the behaviour is described - the upstream source it edits reads exactly as it
 * always did.
 *
 * The comment printer patch below belongs upstream, in the extension's own
 * printer, and can be dropped from here once a release of that repository
 * contains it and provenance.json has been refreshed past the fix. The entry
 * names the upstream function it replaces, so the two can be compared.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The comment printer in the upstream formatter, and the version this package
 * ships.
 *
 * `printComment` runs over every `/*` comment in the buffer and trims each of
 * its lines. Prettier's doc printer then re-indents each line to the enclosing
 * statement, so an author's interior layout cannot survive: the two-space body
 * of a doxygen header, the hanging continuation of a `@param`, the entries
 * under a `<h4>`, and the indented code samples all collapse to the comment's
 * own indent, and `**\/` comes back as ` **\/` from the star replacement.
 *
 * Dedenting by the column the comment started at preserves that layout instead.
 * It also removes exactly the indentation the doc printer is about to re-add,
 * which is the property the trim was reaching for: the opening line carries no
 * leading whitespace in `token.text`, so it is left alone, and every later line
 * loses `min(start column, its own indent)` - never more than it has, which
 * keeps an outdented closing marker from going negative.
 *
 * The closing marker skips the star replacement: it is the one line whose
 * original indentation is part of the comment's shape, and giving it a leading
 * space would move it right on every run.
 */
const COMMENT_PRINTER = [
  `const printComment = (token: Token) => {
  const text = token.text.split("\\n");
  if (text.length === 0 || !token.text.startsWith("/*")) {
    return token.text;
  }
  return join(
    hardline,
    text.map((line) => line.trim().replace(/^\\*/, " *")),
  );
};`,
  `const printComment = (token: Token) => {
  const text = token.text.split("\\n");
  if (text.length === 0 || !token.text.startsWith("/*")) {
    return token.text;
  }

  const indentOf = (line: string) => /^[ \\t]*/.exec(line)![0].length;
  const base = token.start ? token.start.column : 0;

  return join(
    hardline,
    text.map((line, index) => {
      if (line.trim() === "") {
        return "";
      }

      const dedented = (
        index === 0 ? line : line.slice(Math.min(base, indentOf(line)))
      ).trimEnd();

      return /^\\*+\\/$/.test(dedented)
        ? dedented
        : dedented.replace(/^\\*/, " *");
    }),
  );
};`
]

/**
 * A macro invocation written as a standalone line has no required semicolon.
 * Close only a complete parenthesised call whose next non-comment token starts
 * on a later line; expressions and calls followed by a semicolon keep their
 * original statement. Count separator tokens only, not parentheses in strings,
 * comments or the raw text produced by preserveQuoting. Comments can precede
 * the call or appear between its name and opening parenthesis, but a preceding
 * non-comment token means the call is part of a larger statement. The token
 * callback copies start and end from the lexer (SyntaxProvider.ts); parser.ts
 * also relies on both positions throughout, including its trailing-comment code.
 */
const MACRO_CALL_END = [
  `      quoting = preserveQuoting(quoting, currentStatement, model);
      if (quoting >= 0) {
        continue;
      }

      //#region --- Check for statement end
      if (node.type === "sep" && node.text === ";") {`,
  `      quoting = preserveQuoting(quoting, currentStatement, model);
      if (quoting >= 0) {
        continue;
      }

      //#region --- Check for statement end
      const callTokens = currentStatement.children;
      const first = callTokens.findIndex((token) => !isComment(token));
      const open = callTokens.findIndex((token, index) => index > first && !isComment(token));
      let callDepth = 0;
      let completeMacroCall = false;
      if (
        first >= 0 && callTokens[first].type === "macro-ref" &&
        open >= 0 && callTokens[open].type === "sep" && callTokens[open].text === "(" &&
        node.type === "sep" && node.text === ")"
      ) {
        for (let j = open; j < callTokens.length; j++) {
          const token = callTokens[j];
          if (token.type !== "sep") continue;
          if (token.text === "(") callDepth++;
          if (token.text === ")") callDepth--;
          if (callDepth === 0) {
            completeMacroCall = j === callTokens.length - 1;
            break;
          }
        }
      }
      const nextNonComment = completeMacroCall
        ? tokens.slice(i + 1).find((token) => !isComment(token))
        : undefined;
      const standaloneMacroCall = completeMacroCall &&
        (!nextNonComment || (nextNonComment.start.line > node.end.line &&
          nextNonComment.type !== "sep"));
      if ((node.type === "sep" && node.text === ";") || standaloneMacroCall) {`
]

/**
 * A blank line after a standalone comment, carried on the statement.
 *
 * A comment is printed as a statement of its own, and the branch that finalises
 * it never looks at what follows, so the pass that preserves a blank line
 * between two statements does not run for it: the break an author leaves under
 * a doxygen header, or between a comment and the code it introduces,
 * disappears. `blankLineAfter` carries it to the printer, which renders it as
 * one more hardline. A flag rather than a `raw-data` child because a child goes
 * through `fill`, whose separator prints as a trailing space on the comment's
 * last line - the one thing a formatter must never add.
 *
 * More than one line between the comment's end and the next token means the
 * author left a blank line there; a comment written directly above the next
 * statement is left alone.
 */
const STANDALONE_COMMENT_BLANK_LINE = [
  `      } else if (currentStatement.children.length === 1 && isComment(node)) {
        // standalone comment, treat as a whole statement
        prevStatement = currentStatement;`,
  `      } else if (currentStatement.children.length === 1 && isComment(node)) {
        // standalone comment, treat as a whole statement
        const afterComment = tokens[i + 1];
        if (afterComment && afterComment.start.line - node.end.line > 1) {
          // preserve the blank line the author left after the comment
          currentStatement.blankLineAfter = true;
        }
        prevStatement = currentStatement;`
]

/**
 * The field the patch above sets. It is read by the printer, which the type
 * has to describe.
 */
const STATEMENT_BLANK_LINE_AFTER = [
  `export interface Statement {
  type: "statement";
  name: string;
  children: Token[];
  leadingComment?: Token;
}`,
  `export interface Statement {
  type: "statement";
  name: string;
  children: Token[];
  leadingComment?: Token;
  blankLineAfter?: boolean;
}`
]

/**
 * The same paragraph break, for a comment the parser hands to a statement as
 * `leadingComment`.
 *
 * Inside a region, a comment that opens the region is attached to the statement
 * that follows it, and the printer joins the two with a single `hardline`, so a
 * blank line between them disappears. `first` is the statement's own first
 * token: a gap of more than one line from the comment's end means the source
 * had a blank line there, and one more `hardline` carries it.
 *
 * The gap is measured only when there is a token to measure from. A statement
 * reaches this function with at least one child - the printer dispatches on
 * `node.children?.length` - so the `first` operand is guarded for the shape the
 * AST does not currently produce rather than because it occurs: `"start" in
 * undefined` throws from inside the print pass, and a formatter that throws has
 * rewritten nothing and said nothing.
 */
const LEADING_COMMENT_BLANK_LINE = [
  `  return node.leadingComment
    ? [printComment(node.leadingComment), hardline, statement]
    : statement;`,
  `  if (!node.leadingComment) {
    return node.blankLineAfter ? [statement, hardline] : statement;
  }

  const commentGap =
    first && "start" in first && first.start
      ? first.start.line - node.leadingComment.end.line
      : 0;

  return [
    printComment(node.leadingComment),
    hardline,
    ...(commentGap > 1 ? [hardline] : []),
    statement,
    ...(node.blankLineAfter ? [hardline] : []),
  ];`
]

/**
 * A cards section is data, and is printed exactly as it was written.
 *
 * `datalines`, `cards`, `lines` and their `4` variants open a section whose
 * body is not SAS code to the printer's eyes until the lexer marks it
 * `cards-data`, and the lexer only does that once its own state machine has
 * entered a cards block. In open code - `filename ft15f001 temp; parmcards4;`
 * with the body and the terminator that follow, which is how the macro tests
 * stage a program - it never does, so every line of the body was reflowed as
 * statements: indentation was dropped and the `;;;;` terminator became one
 * semicolon appended to the last data line plus three lines of `;`.
 *
 * SAS still runs that, but the file no longer says what it meant, and a reader
 * that looks for a line holding only `;;;;` - the linter's data-section scan is
 * one - then never finds it, treats everything to the end of the buffer as
 * data, and reports no macro invocations at all. `noUnusedMacros` reads that as
 * "none of these declarations are used" and deletes the whole header list.
 *
 * It is worse than layout. The semicolon a `datalines;` block ends with is
 * appended to its last record, so `3,4` is read back as `3,4;` - the formatter
 * changed the data, silently, in a file whose whole purpose is to carry it.
 *
 * So a statement that opens a cards section is rewritten as one `raw-data`
 * token covering the section through its terminator, which the printer already
 * prints verbatim (that is the path a `cards-data` token takes), and the tokens
 * inside it are skipped. The terminator is read the way SAS reads it: for the
 * `4` variants a line of four or more semicolons, which may be indented - every
 * macro in the corpus that stages a program inside a `%do` block writes its
 * `;;;;` at the block's indent - and for a plain section a line whose first
 * character is a semicolon, where a leading blank makes the line data. A lone
 * `;` record inside a `parmcards4` block is an empty statement in the program
 * the section carries, never the end of the section.
 *
 * A section with no terminator at all is a truncated member, or one whose
 * terminator lives in a file this buffer is not: the section means "everything
 * that follows is data", so the verbatim region runs to the end of the model.
 * Left unterminated in the AST, the section's own records came back but the
 * line after them still counted as a statement boundary - inside a DATA step
 * that added one blank line per run, so the file never settled, and in open
 * code the records were reflowed as statements and joined onto one line, which
 * is a data change. The region stops at the last line that holds something,
 * because the trailing newline is the printer's to add and counting it as data
 * printed two.
 *
 * The token starts at column 0 of the keyword's line, so the author's own
 * indentation travels with the text: a raw-data statement is printed with
 * `markAsRoot`, which stops the doc printer re-indenting it, so a section that
 * only kept its body would come back flush left inside the DATA step it belongs
 * to.
 *
 * That also means a cards section is never re-indented. A `parmcards4;` written
 * inside a `%do` block keeps the column the author gave it, even where the
 * printer moves its siblings, and a second format leaves it there - which is
 * not the layout of the surrounding block. It is deliberate: the body is data,
 * its leading columns are the author's, and aligning the keyword with its
 * siblings means shifting every record by the same amount. The alternative this
 * replaces - reflowing the section as statements - is what rewrote the records.
 * The section's layout belongs to whoever wrote it.
 */
const CARDS_SECTION_VERBATIM = [
  `      quoting = preserveQuoting(quoting, currentStatement, model);
      if (quoting >= 0) {
        continue;
      }

      //#region --- Check for statement end`,
  `      quoting = preserveQuoting(quoting, currentStatement, model);
      if (quoting >= 0) {
        continue;
      }

      //#region --- Preserve a cards section verbatim
      if (
        node.type === "sep" &&
        node.text === ";" &&
        currentStatement.children.length === 2 &&
        /^(datalines|cards|lines|parmcards)4?$/i.test(currentStatement.name)
      ) {
        const four = /4$/i.test(currentStatement.name);
        const firstToken = currentStatement.children[0];
        const start =
          "start" in firstToken && firstToken.start
            ? { line: firstToken.start.line, column: 0 }
            : node.start;
        let line = node.end.line + 1;
        let sectionEnd: { line: number; column: number } | undefined;
        while (line < model.getLineCount()) {
          const content = model.getLine(line).replace(/\\r?\\n$/, "");
          // SAS ends a *4 section at a line of four or more semicolons, and a
          // plain section at a line whose FIRST character is a semicolon - a
          // leading blank there makes the line data, so the untrimmed line is
          // what that test reads. The *4 test is content-based because the
          // terminator arrives indented in the corpus (every macro that stages a
          // program inside a %do block writes its ;;;; at the block's indent),
          // and a lone semicolon inside a parmcards4 block is an empty statement
          // in the program the section carries, not its end.
          const ends = four
            ? /^;{4,}$/.test(content.trim())
            : content.startsWith(";");
          if (ends) {
            sectionEnd = { line, column: content.length };
            break;
          }
          line++;
        }
        if (start && !sectionEnd) {
          // No terminator: the section is data to the end of the buffer.
          let lastLine = model.getLineCount() - 1;
          let lastContent = model.getLine(lastLine).replace(/\\r?\\n$/, "");
          while (lastLine > node.end.line && lastContent === "") {
            lastLine--;
            lastContent = model.getLine(lastLine).replace(/\\r?\\n$/, "");
          }
          sectionEnd = { line: lastLine, column: lastContent.length };
        }
        if (start && sectionEnd) {
          while (
            i + 1 < tokens.length &&
            tokens[i + 1].start.line <= sectionEnd.line
          ) {
            i++;
          }
          currentStatement.children = [
            {
              type: "raw-data",
              text: model.getText({ start, end: sectionEnd }),
              start,
              end: sectionEnd,
            },
          ];
          const afterSection = tokens[i + 1];
          // A statement that opens a region (DATA, PROC, %macro) is printed with
          // a blank line of its own before it, so the author's blank line there
          // is already carried: adding ours as well printed two, and a second
          // format added a third.
          const afterStartsRegion =
            !!afterSection &&
            (afterSection.type === "sec-keyword" ||
              afterSection.type === "macro-sec-keyword") &&
            (() => {
              const block = syntaxProvider.getFoldingBlock(
                afterSection.start.line,
                afterSection.start.column,
                true,
                true,
                true
              );
              return (
                !!block &&
                block.startLine === afterSection.start.line &&
                block.startCol === afterSection.start.column
              );
            })();
          if (
            afterSection &&
            !afterStartsRegion &&
            afterSection.start.line - sectionEnd.line > 1
          ) {
            // the blank line the author left after the terminator
            currentStatement.children.push({
              type: "raw-data",
              text: "\\n",
              start: sectionEnd,
              end: afterSection.start,
            });
          }
          prevStatement = currentStatement;
          currentStatement = undefined;
          continue;
        }
      }
      //#endregion ---

      //#region --- Check for statement end`
]

/**
 * A macro that returns a value ends its last statement without a semicolon -
 * `%macro f(); &x %mend f;` - which is how every `mf_` function in @sasjs/core
 * is written. Nothing in the parser ended that statement, so the expression
 * swallowed the `%mend`: the printer then joined them (`&x %mend f;` on one
 * line), the closing keyword stopped being a statement the rules could see
 * (`hasMacroNameInMend` reports "Missing %mend statement"), and the region was
 * left open - which is why the `%mend` came back indented as part of the body.
 *
 * A `%mend` always starts a statement of its own, so the statement in progress
 * is finished when one arrives. The region bookkeeping then runs where it
 * belongs: on the `%mend` statement's own end.
 */
const MEND_ENDS_THE_STATEMENT = [
  `      //#region --- Check for statement start
      if (!currentStatement) {`,
  `      // A %mend starts a statement of its own, so a statement still open when
      // one arrives is finished - the semicolon-less return value of a macro
      // function otherwise swallows the keyword, which the printer then shares
      // its line with and the rules stop seeing.
      if (
        currentStatement &&
        currentStatement.children.length &&
        /^%mend$/i.test(node.text)
      ) {
        prevStatement = currentStatement;
        currentStatement = undefined;
      }

      //#region --- Check for statement start
      if (!currentStatement) {`
]

/**
 * A whitespace-separated %end also closes an unterminated value, but not text
 * directly adjacent to it: adding whitespace there could change macro output.
 * Leave quoting and format-ignore regions untouched, as well as an in-progress
 * macro statement or parenthesised expression. Its anchor is upstream parser
 * code following the %mend patch, not the wording of that patch's comment.
 */
const END_ENDS_THE_STATEMENT = [
  `      //#region --- Check for statement start
      if (!currentStatement) {`,
  `      // End a semicolon-less value before a whitespace-separated %end.
      if (
        currentStatement &&
        currentStatement.children.length &&
        quoting < 0 && preserveCustom < 0 &&
        /^%end$/i.test(node.text) &&
        !isSamePosition(currentStatement.children[currentStatement.children.length - 1].end, node.start) &&
        currentStatement.children.reduce((depth, token) => {
          if (token.type !== "sep") return depth;
          if (token.text === "(") return depth + 1;
          if (token.text === ")") return depth - 1;
          return depth;
        }, 0) === 0 &&
        (currentStatement.children[0].type !== "macro-keyword" ||
          (currentStatement.children.length > 2 &&
            currentStatement.children[1].type === "sep" &&
            currentStatement.children[1].text === "(" &&
            currentStatement.children[currentStatement.children.length - 1].text === ")")) &&
        currentStatement.children[0].type !== "macro-sec-keyword"
      ) {
        prevStatement = currentStatement;
        currentStatement = undefined;
      }

      //#region --- Check for statement start
      if (!currentStatement) {`
]

/**
 * A masking function's argument that is itself a program is printed verbatim.
 *
 * `%nrstr(`, `%str(` and their kin take an argument the macro compiler does not
 * resolve, and in the macro library that argument is sometimes a whole program
 * - `%let rc=%sysfunc(dosubl(%nrstr( proc cas; ... run; )));`, how every `mfv_`
 * function stages its work. The lexer does not know the text is masked, so the
 * `proc` and `data` keywords inside it open regions, and opening a region
 * abandons the statement the masking call belongs to. Every further token then
 * pops against a statement with nothing left in it, and the print pass throws
 * `Cannot read properties of undefined (reading 'start')` - the formatter
 * refuses the file rather than printing it wrong, which is the safe failure but
 * still a file no consumer can format.
 *
 * Guarding the pop is not the fix: the tokens are already gone, so the region's
 * content would be printed as nothing at all and the program inside the mask -
 * silently - deleted.
 *
 * So the argument is captured the way a cards section is: at the opening
 * parenthesis of the masking call, before anything has been popped, one
 * `raw-data` token is taken from the statement's own line through the closing
 * parenthesis, and the tokens inside it are skipped. Capture indentation when
 * the prefix is whitespace, but start at the statement when earlier code is
 * on the same line, so that earlier code is not emitted a second time.
 *
 * The closing parenthesis is found by scanning text rather than by counting
 * tokens, because the tokens are what cannot be trusted here: strings are
 * skipped (a `)` inside one is text), as are block comments, and the quote of
 * `%str(%")` - which the macro library writes constantly - opens nothing
 * because a masking marker's quote is not a string.
 *
 * Only an argument that spans statements is taken. One expression - the common
 * `%str( )`, `%nrstr(&a)` - is already printed correctly by the statement's own
 * layout, and capturing it would stop the printer formatting around it. The test
 * is whether a token inside the argument would have opened a region or ended the
 * statement's macro: a secondary keyword (`data`, `proc`), or `%mend`. A `%end`
 * is not a test on its own - the parser already ignores one while a masking
 * region is open - and capturing on it moved an ordinary one-line mask out of
 * the indentation of the block it sits in.
 *
 * This patch anchors on the cards patch's own region marker, so it is listed
 * after that one: it inserts itself between the quoting call and the region.
 */
const MASKING_REGION_VERBATIM = [
  `      quoting = preserveQuoting(quoting, currentStatement, model);
      if (quoting >= 0) {
        continue;
      }

      //#region --- Preserve a cards section verbatim`,
  `      quoting = preserveQuoting(quoting, currentStatement, model);

      //#region --- Preserve a masking argument that spans statements
      if (
        quoting === 1 &&
        node.type === "sep" &&
        node.text === "(" &&
        currentStatement.children.length > 0
      ) {
        let closeAt: { line: number; column: number } | undefined;
        let spansToEnd = false;
        let depth = 1;
        let inComment = false;
        let stringQuote: string | undefined;

        layout: for (
          let scanLine = node.end.line;
          scanLine < model.getLineCount();
          scanLine++
        ) {
          const content = model.getLine(scanLine).replace(/\\r?\\n$/, "");
          for (
            let column = scanLine === node.end.line ? node.end.column : 0;
            column < content.length;
            column++
          ) {
            const char = content[column];
            // An odd run of percent signs marks the following quote or
            // parenthesis; pairs represent literal percent signs.
            let percentCount = 0;
            for (let previous = column - 1; content[previous] === "%"; previous--) {
              percentCount++;
            }
            const masked = percentCount % 2 === 1;
            if (stringQuote) {
              if (char === stringQuote) {
                if (content[column + 1] === stringQuote) {
                  column++;
                } else {
                  stringQuote = undefined;
                }
              }
              continue;
            }
            if (inComment) {
              if (char === "*" && content[column + 1] === "/") {
                inComment = false;
                column++;
              }
              continue;
            }
            if (char === "/" && content[column + 1] === "*") {
              inComment = true;
              column++;
              continue;
            }
            if (
              (char === '"' || char === "'") &&
              !masked
            ) {
              // Keep quote state across lines; doubled quotes are string text.
              stringQuote = char;
              continue;
            }
            // Marked parentheses are text, not argument boundaries.
            if (char === "(" && !masked) {
              depth++;
            } else if (char === ")" && !masked) {
              if (--depth === 0) {
                closeAt = { line: scanLine, column: column + 1 };
                break layout;
              }
            }
          }
        }

        // No closing parenthesis: the mask is never closed, so the rest of the
        // buffer is its argument. \`%nrstr(\` at the end of a truncated member is
        // what that looks like, and leaving the region open deleted everything
        // after the call - the tokens were popped and never re-emitted. The
        // region runs to the end of the model instead, as an unterminated cards
        // section does, and stops at the last line holding something because
        // the printer adds the final newline itself.
        if (!closeAt) {
          let lastLine = model.getLineCount() - 1;
          let lastContent = model.getLine(lastLine).replace(/\\r?\\n$/, "");
          while (lastLine > node.end.line && lastContent === "") {
            lastLine--;
            lastContent = model.getLine(lastLine).replace(/\\r?\\n$/, "");
          }
          closeAt = { line: lastLine, column: lastContent.length };
          spansToEnd = true;
        }

        const inside = (position: { line: number; column: number }) =>
          !!closeAt &&
          (position.line < closeAt.line ||
            (position.line === closeAt.line &&
              position.column < closeAt.column));

        let spansStatements = spansToEnd;
        let lastInside = i;
        for (let j = i + 1; j < tokens.length && inside(tokens[j].start); j++) {
          lastInside = j;
          if (
            tokens[j].type === "sec-keyword" ||
            tokens[j].type === "macro-sec-keyword" ||
            /^%mend$/i.test(tokens[j].text)
          ) {
            spansStatements = true;
          }
        }

        const firstToken = currentStatement.children[0];
        const start =
          "start" in firstToken && firstToken.start
            ? {
                line: firstToken.start.line,
                column: model.getLine(firstToken.start.line)
                  .slice(0, firstToken.start.column).trim() === ""
                  ? 0 : firstToken.start.column,
              }
            : undefined;

        if (spansStatements && closeAt && start) {
          currentStatement.children = [
            {
              type: "raw-data",
              text: model.getText({ start, end: closeAt }),
              start,
              end: closeAt,
            },
          ];
          // The closing parenthesis belongs to the region; the separators that
          // close the enclosing calls, and the semicolon that ends the
          // statement, are parsed as they would be.
          i = lastInside;
          quoting = -1;
          continue;
        }
      }
      //#endregion ---

      if (quoting >= 0) {
        continue;
      }

      //#region --- Preserve a cards section verbatim`
]

/**
 * The raw statement keeps the source gaps between any following tokens: macro
 * values and PUT output may depend on those spaces. Preserve the existing
 * statement-end handling rather than guessing where enclosing calls end.
 */
const RAW_STATEMENT_GAPS = [
  `      currentStatement.children.push(node);

      preserveCustom = preserveCustomRegion(`,
  `      // Preserve whitespace after a verbatim token as part of the statement.
      if (currentStatement.children[0]?.type === "raw-data" &&
          currentStatement.children.length && node.start) {
        const previous = currentStatement.children[currentStatement.children.length - 1];
        if (previous.end) {
          const gap = model.getText({ start: previous.end, end: node.start });
          if (gap) {
            currentStatement.children.push({
              type: "raw-data", text: gap, start: previous.end, end: node.start,
            });
          }
        }
      }
      currentStatement.children.push(node);

      preserveCustom = preserveCustomRegion(`
]

/** Do not preserve a gap twice when the following folding block prints one. */
const VERBATIM_BEFORE_BLOCK = [
  `          if (lineGap > minGapToPreserve) {`,
  `          const nextBlock =
            currentStatement.children[0].type === "raw-data" &&
            (nextToken.type === "sec-keyword" || nextToken.type === "macro-sec-keyword")
              ? syntaxProvider.getFoldingBlock(
                  nextToken.start.line, nextToken.start.column, true, true, true,
                )
              : undefined;
          const nextStartsBlock = nextBlock &&
            nextBlock.startLine === nextToken.start.line &&
            nextBlock.startCol === nextToken.start.column;
          if (lineGap > minGapToPreserve && !nextStartsBlock) {`
]

/**
 * A comment attached after a semicolon is a separate statement if it wraps.
 * Use the enclosing statement's indentation at that break, rather than the
 * continuation indent used between tokens inside a statement. A region opener
 * is the exception: on the next pass its comment belongs to the region's body.
 * Keep the `line` separator so short trailing comments stay on the same line.
 */
const TRAILING_COMMENT_REGION = [
  `      return printStatement(node);`,
  `      return printStatement(node, path.isFirst && path.parent?.type === "region");`
]

const TRAILING_COMMENT_REGION_PARAMETER = [
  `const printStatement = (node: Statement) => {`,
  `const printStatement = (node: Statement, opensRegion: boolean) => {`
]

const TRAILING_COMMENT_INDENT = [
  `                indent(
                  isEqualsSign(token) ||
                    (isEqualsSign(preToken) &&
                      index + 1 < others.length &&
                      !isEqualsSign(others[index + 1]))
                    ? // trim whitespace around equals sign
                      softline
                    : line,
                ),`,
  `                isComment(token) && preToken.type === "sep" && preToken.text === ";" && !opensRegion
                  ? line // a wrapped trailing comment starts at statement indentation
                  : indent(
                      isEqualsSign(token) ||
                        (isEqualsSign(preToken) &&
                          index + 1 < others.length &&
                          !isEqualsSign(others[index + 1]))
                        ? // trim whitespace around equals sign
                          softline
                        : line,
                    ),`
]

/**
 * Every patch, with the file it applies to, relative to `.upstream/server`.
 *
 * `applied` is the marker that says the file already carries the patch. It has
 * to be a string only the patched version contains, so it survives a rebuild
 * and a re-fetch that wiped `.upstream` is patched again rather than trusted.
 */
const PATCHES = [
  {
    file: 'server/src/sas/formatter/printer.ts',
    name: 'comment printer keeps the layout of a comment body',
    replace: COMMENT_PRINTER,
    applied: 'const base = token.start ? token.start.column : 0;'
  },
  {
    file: 'server/src/sas/formatter/printer.ts',
    name: 'identify region-opening statements for trailing comments',
    replace: TRAILING_COMMENT_REGION,
    applied: 'return printStatement(node, path.isFirst && path.parent?.type === "region");'
  },
  {
    file: 'server/src/sas/formatter/printer.ts',
    name: 'pass region ownership to statement printer',
    replace: TRAILING_COMMENT_REGION_PARAMETER,
    applied: 'const printStatement = (node: Statement, opensRegion: boolean) => {'
  },
  {
    file: 'server/src/sas/formatter/printer.ts',
    name: 'wrapped trailing comments use statement indentation',
    replace: TRAILING_COMMENT_INDENT,
    applied: '// a wrapped trailing comment starts at statement indentation'
  },
  {
    file: 'server/src/sas/formatter/parser.ts',
    name: 'standalone macro calls end at their closing parenthesis',
    replace: MACRO_CALL_END,
    applied: 'const standaloneMacroCall = completeMacroCall &&'
  },
  {
    file: 'server/src/sas/formatter/parser.ts',
    name: 'a semicolon-less return value ends at %mend',
    replace: MEND_ENDS_THE_STATEMENT,
    applied: 'A %mend starts a statement of its own'
  },
  {
    file: 'server/src/sas/formatter/parser.ts',
    name: 'a whitespace-separated macro end closes a semicolon-less value',
    replace: END_ENDS_THE_STATEMENT,
    applied: 'End a semicolon-less value before a whitespace-separated %end.'
  },
  {
    file: 'server/src/sas/formatter/parser.ts',
    name: 'the statement type can mark a blank line after a comment',
    replace: STATEMENT_BLANK_LINE_AFTER,
    applied: '  blankLineAfter?: boolean;'
  },
  {
    file: 'server/src/sas/formatter/parser.ts',
    name: 'a standalone comment keeps the blank line after it',
    replace: STANDALONE_COMMENT_BLANK_LINE,
    applied: 'currentStatement.blankLineAfter = true;'
  },
  {
    file: 'server/src/sas/formatter/parser.ts',
    name: 'a cards section is printed verbatim, terminator included',
    replace: CARDS_SECTION_VERBATIM,
    applied: '//#region --- Preserve a cards section verbatim'
  },
  {
    file: 'server/src/sas/formatter/printer.ts',
    name: 'a leading comment keeps the blank line before its statement',
    replace: LEADING_COMMENT_BLANK_LINE,
    applied: 'const commentGap ='
  },
  {
    file: 'server/src/sas/formatter/parser.ts',
    name: 'a masking argument that spans statements is printed verbatim',
    replace: MASKING_REGION_VERBATIM,
    applied: '//#region --- Preserve a masking argument that spans statements'
  },
  {
    file: 'server/src/sas/formatter/parser.ts',
    name: 'a verbatim statement preserves gaps between subsequent tokens',
    replace: RAW_STATEMENT_GAPS,
    applied: '// Preserve whitespace after a verbatim token as part of the statement.'
  },
  {
    file: 'server/src/sas/formatter/parser.ts',
    name: 'a verbatim statement before a block does not duplicate its gap',
    replace: VERBATIM_BEFORE_BLOCK,
    applied: 'const nextStartsBlock = nextBlock &&'
  }
]

const upstreamRoot = () => join(root, '.upstream', 'server')

/**
 * Applies every patch to the fetched tree.
 *
 * Called by the server build, which compiles the upstream tree, and by both
 * format builds, which bundle it directly - a `build:format` on its own needs
 * the same source the server build would have patched.
 *
 * A missing tree is not an error here: each caller already fails with its own
 * message when the source it needs is absent, and this runs before those checks
 * in one of them.
 */
export const patchUpstream = () => {
  const base = upstreamRoot()

  for (const { file, name, replace, applied } of PATCHES) {
    const path = join(base, file)

    if (!existsSync(path)) {
      continue
    }

    const [from, to] = replace
    let source = readFileSync(path, 'utf8')

    if (source.includes(applied)) {
      continue
    }

    if (!source.includes(from)) {
      throw new Error(
        `upstream ${file} does not contain the code "${name}" patches, ` +
          'so the patch did not apply - read the patch, and the upstream ' +
          'function it replaces, before refreshing provenance.json'
      )
    }

    if (source.indexOf(from) !== source.lastIndexOf(from)) {
      throw new Error(`upstream ${file} has multiple anchors for "${name}"`)
    }

    source = source.replace(from, () => to)
    writeFileSync(path, source)

    console.log(`patched upstream ${file}: ${name}`)
  }
}
