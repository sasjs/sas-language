/**
 * SAS log parsing, re-exported.
 *
 * The parser lives in `@sasjs/utils/logs`, and that is where a host should get
 * it from: every consumer in the org already has `@sasjs/utils`, and a log
 * parser is SAS knowledge rather than editor wiring. This entry point stays for
 * the hosts that load THIS package and nothing else - the Studio's web app
 * depends on `@sasjs/sas-language` for its completions and hover text and has no
 * `@sasjs/utils` of its own - so the published `./logs` import keeps working and
 * there is still one implementation.
 *
 * The re-export is the one interesting line here: this package publishes ES
 * modules and `@sasjs/utils` publishes CommonJS, so `parseLog` and `nextIssue`
 * arrive through Node's named-export detection rather than as an ES module. The
 * path names the file (`logs/index.js`) because `@sasjs/utils` carries no
 * `exports` map, and an ES module importer gets no directory or extension
 * resolution - `@sasjs/utils/logs` alone is a CommonJS-only spelling. The
 * package's own tests run against the built file, which is what proves the
 * indirection works rather than assuming it.
 */
export * from '@sasjs/utils/logs/index.js'
