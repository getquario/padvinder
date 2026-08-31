# padvinder

Tiny, CSP-safe RFC 9535 JSONPath engine. Plain JS + JSDoc. The filter grammar lives here; bounded I-Regexp matching comes from treffer. `lib/index.js` is the implementation and the package.

Work is done when `npm run check` is green. Scripts live in `package.json`. Run them on Node: Bun accepts `--disallow-code-generation-from-strings` but does not enforce it. A single suite is `node --disallow-code-generation-from-strings --test test/query.test.js`. Public syntax and API live in `README.md`; the host-facing surface (`paths`, `singular`, `relocate`, diagnostic identity, delegated pattern diagnostics) lives in `EMBEDDING.md`.

## Architecture

`segments(path, j, fns, soft)` parses consecutive segments into closures `(nodes, root) => nodes`; `run()` reduces them over a start nodelist. `query()` calls it in hard mode (errors on junk); the filter parser calls it in soft mode (stops at the first char that cannot start a segment). No JSONPath AST, no string-to-code path.

Bracket contents are scanned by `close()` (matching `]` with nesting and string awareness) and `split()` (top-level commas for unions). Each segment carries a `sing` flag (singular: one name/index selector, not a descendant) that the filter parser uses for ValueType position.

Filters are RFC 9535, parsed by `rfcFilter()`: recursive descent (`or`/`and`/`basic`/`primary`) producing `(node, root) => boolean`. A bare query is an existence test (nodelist length). `cmp()` implements RFC comparison (deep `==` via `deepEq`, `NOTHING` for absent singular queries, orderings only for same-typed number/string pairs). The five built-in function extensions live in `RFCFN`; a name not in `RFCFN` is looked up in the caller's registry and treated as a function extension taking value-type args. That registry step is the one deliberate step beyond strict RFC; the compliance suite only exercises the built-ins. A malformed filter throws `SyntaxError` at compile time; there is no fallback.

`match()`/`search()` compile through treffer with `{ anchors: true }`. A pattern written as a quoted literal in the query is compiled when the query compiles — an invalid or resource-limited literal is a located fault at the literal, carrying the class and `TREFFER_*` code treffer gave it. `reTest()` keeps a one-entry cache so a document-supplied pattern compiles at most once while filtering a document. For those data-supplied patterns, treffer errors and resource-limit failures become false, preserving RFC function behavior.

## Safety

- Compose closures that already exist in the shipped source. Source-scan tests grep `lib/` for `\beval\b`, `Function(`, and `new Function`, so comments in `lib/` have to avoid those spellings. The suite runs under `--disallow-code-generation-from-strings`.
- `child()`, `kids()`, and `deepEq()` are the access boundary. Every data read goes through them. Each skips `__proto__`/`constructor`/`prototype` and matches own properties only (`Object.hasOwn`). Blocked keys match nothing everywhere, including inside filters: queries are search, not access. That is intentional and pinned by the safety suite.
- `rfcFilter()` builds `(node, root) => boolean` from pre-existing functions. It never emits or runs source text. It must consume the whole filter and throw `SyntaxError` on anything non-RFC.
- Treffer and [waarmerk](https://github.com/getquario/waarmerk) are the runtime dependencies. Keep `match()`/`search()` on treffer with `{ anchors: true }`, preserve the one-entry cache, and convert matcher errors to false at row time — but a quoted-literal pattern fails loud at query compile; do not "tidy" that back to soft.
- Diagnostics are minted, authenticated and relocated through waarmerk. treffer shares it; xprsn and sjabloon still hand-roll their own copies and are being moved over. `store()` at module load, `mint`/`capped` to throw, `relocate` re-exported with this module's store applied. Do not hand-roll a second copy of that machinery here — it drifted four ways before it was extracted.
- `located()` is how a bad pattern literal reaches a caller: treffer's diagnostic relocated with `span` (not `offset` — the pattern crossed a JSON decode, so no shift lands on the offender) and then `adopt`ed into this module's store. It keeps treffer's class and code and gains padvinder's span, and as thrown it passes both packages' `isDiagnostic` — an embedder that relocates it again keeps only ours, since a relocation registers the copy in the store it was called with. The store's union carries `TrefferErrorCode` for exactly this, which is what makes `PadvinderDiagnostic.code` true by construction.
- `test/browser/harness.js` serves `lib/` **verbatim**. Bare specifiers are resolved by an import map the page declares, whose sha256 is what lets it run under a policy that forbids inline script; the harness reads that map out of the page rather than restating it. The hash makes the policy follow the page rather than stand apart from it: whatever the map declares is authorised by construction, which is the point — the two cannot disagree — but it is not an independent check on the map's contents. Never rewrite the source on the way out — this suite proves the published file runs under a strict CSP, and a rewritten copy would prove it of something nobody installs. A check in the harness fetches every served module back — dependencies included — and fails if any differs from its source on disk. Add a dependency to the map and to the route table, resolving it through `import.meta.resolve` rather than a hardcoded path.
- Queries never modify the input (a test snapshots and compares).

Size is a soft goal (budget in `package.json`, `treffer` ignored so the number is padvinder's own code). The compliance suite is the correctness gate, not size. Name bindings for readers; a consumer minifier mangles them anyway, and `lib/` ships verbatim so those names show up in stack traces. Property names do not mangle (`Loc.value`, `Loc.depth`). Keep the guard and the passing test; then check `npm run size`.

## Semantics

`test/` is the executable spec. The official CTS in `test/cts.json` (BSD-2, `test/cts.LICENSE`) pins RFC behavior. These look like bugs if you tidy them:

- Non-matches return `[]`, never throw: missing keys, out-of-range indexes, wrong node types.
- Malformed paths and filters throw `SyntaxError` at compile time. Filters never throw at runtime; a missing or blocked path is absent.
- Negative indexes count from the end. Slices follow RFC 9535 (negative steps walk backwards, step 0 selects nothing).
- Bracket keys are RFC-typed: a quoted name selects only from objects, an index only from arrays.
- `..` applies the following segment to the node and every descendant, in document order. `all()` carries an ancestor set so cyclic data cannot hang it.
- RFC filters: existence is present-not-truthy (`[?@.a]` matches `{a: null}`), `==` is deep equality, absent singular queries are `NOTHING`. `test/compliance.test.js` must account for every valid CTS case. `DIALECT` stays empty unless a new CTS update needs a documented divergence; an entry that starts passing must come out of the ledger.
- I-Regexp follows RFC 9485 plus CTS-compatible `^`/`$` anchors. JavaScript-only escapes and assertions are invalid: a quoted-literal pattern using them is a located compile fault, while a data-supplied one returns no match. Matching iterates Unicode scalar values; lone surrogates and row-time resource-limit failures return no match.

## Conventions

Omakase: one obvious path over knobs. Test the guarantee a user relies on. Add complexity when concrete pressure shows up.

- oxfmt owns formatting on its defaults. `npm run fmt`. `.oxfmtrc.json` exists for one ignore: `test/cts.json`, vendored verbatim and re-fetched by `npm run cts:update`. Formatting it would fail `fmt:check` on the next update and destroy the upstream diff. Leave that the only ignore.
- Comments only where the code cannot: safety rationale, non-obvious tricks.
- Bindings named for readers (`node`, `value`, `depth`, `children`, `sliceMatch`), and `Loc.value`/`Loc.depth` with them: `Loc` is the shape a reader follows through the whole engine, so it stays spelled out. The compile-time plumbing does not — `Sel`, `Seg`, `Query`, and `Prim` ship one-letter keys (`r`/`t`, `s`/`f`), because only the engine ever touches them and property names do not mangle. Loop counters stay short. Rename with a scope-aware tool: a bare `s` named the raw string, the bracket text, and the selector spec in three functions, and `{ x }` shorthand renames the property.
- Tests are `node:test` in `test/*.test.js` (`query`, `errors`, `safety`, `compliance`), run against `lib/`. New path or filter syntax, or a new guard, belongs in the matching suite and in `fuzz/structured.fuzz.js`.
- Treat names as original. Leave Symfony unmentioned in code, comments, and docs.
- ESM only. Two module formats would split the diagnostics WeakMap across a `require` / `import` seam. The browser harness rewrites the bare `treffer` import to a served path and resolves the real file through `import.meta.resolve`.
- Conventional Commits, at most 80 characters, checked by `commitlint.config.mjs` from `.githooks/commit-msg`. Enable it once per clone with `git config core.hooksPath .githooks`. The hook fails rather than skips when commitlint is missing: no CI job checks messages, so a skip would be no gate at all, and this repo's release notes are generated from these messages. `npm run commitlint -- --last --verbose` checks one by hand.
- `lib/index.d.ts` is hand-written and pulled into `lib/index.js` with `@import`. Generating it would publish `Loc`, `Ctx`, `Sel`, `Seg`, `Arg`, and `Prim`. `checkJs` under `strict` keeps the pair honest: `cap()` takes `PadvinderErrorCode`, so a thrown code the declaration omits fails `npm run test:types`.
- Budget codes must stay literal at the `cap()` call site. The store carries the union — `diags` is a `Store<PadvinderErrorCode | TrefferErrorCode>` — so an undeclared code fails at the line that throws it, which is how `PADVINDER_MAX_COMPARISONS` got out. Do not drop that annotation: `store()` defaults `Code` to `string`, which compiles and checks nothing. Deriving them (`'PADVINDER_' + name…`) satisfies `string` and is invisible to tsc; that is how `PADVINDER_MAX_COMPARISONS` shipped undeclared. `CODES` is positionally parallel to `LIMITS`; add to both, and to the union in `lib/index.d.ts`.
- Suppress `no-unused-expressions` on the expression that trips it (`cond || fail()`) with `// oxlint-disable-next-line` directly above it. oxfmt moves lines, so a trailing `-line` comment slips off its target. Leave the rule live in `.oxlintrc.json`. The `no-unused-vars` suppression on `spec.a.map((t, x) => …)` is a documented oxlint false positive (it misses uses inside a sequence expression). Type-aware suppressions use the `typescript/` prefix the diagnostic reports.
- `oxlint-tsgolint` is the binary that runs the type-aware rules; without it they drop silently.
- `test/types.check.ts` ends scopes with `void [...]` so type-only bindings stay live under `no-unused-vars`.
- Fallow defaults are the gate. Split and table-drive until shipped functions sit under them; leave `maxCognitive` and `maxCrap` alone. With no coverage file, estimated CRAP wants cyclomatic below 5. Duplicated helpers in `fuzz/` get exported. A second name in `ignoreDependencies` means a real graph edge is missing.
