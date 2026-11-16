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
    file: 'server/src/sas/formatter/parser.ts',
    name: 'standalone macro calls end at their closing parenthesis',
    replace: MACRO_CALL_END,
    applied: 'const standaloneMacroCall = completeMacroCall &&'
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
