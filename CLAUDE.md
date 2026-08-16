# padvinder

Tiny, CSP-safe RFC 9535 JSONPath engine. Same family and toolchain as xprsn and sjabloon (plain JS + JSDoc, Node test runner, no build step). The filter grammar lives here; bounded I-Regexp matching comes from treffer.

## Commands

- `npm run check` — the complete pull-request CI quality gate: lint, size, unit and type tests (including compliance coverage), deterministic fuzz regression, and browser CSP. **There is no build step.**
- `npm run lint` — oxlint on its default (correctness) ruleset with `--deny-warnings`, so any warning fails. It runs first in `check` because it is the cheapest step.
- **Non-negotiable: run `npm run check` before declaring any work done.** Passing unit tests alone is not done — a change is complete only when the full gate above is green. Never say "done", close an issue, or hand off without it.
- `npm test` — Node's built-in test runner under `--disallow-code-generation-from-strings` (strict-CSP simulation), then `npm run test:types`: a plain `tsc` that type-checks `lib/` **and** `test/types.check.ts` in one pass, followed by `attw` against a packed tarball to catch module-resolution mistakes the compiler cannot see. Keep this on Node: Bun accepts that V8 flag but does not enforce it.
- `npm run size` — size-limit bundles and minifies `lib/index.js` itself, then checks it against the budget in `package.json`. `treffer` is in the `ignore` list, so the number stays padvinder's own code — which is what makes it able to catch a dependency accidentally being pulled in.
- `npm run test:browser` — serves `lib/` straight to Playwright Chromium under a strict CSP. The harness rewrites the bare `treffer` import to a served path and resolves the real file through `import.meta.resolve`, so it does not care which directory treffer publishes from.
- Run a single suite: `node --disallow-code-generation-from-strings --test test/query.test.js`
- `npm run fuzz` — jazzer.js discovery over `compile`, `find`, `structured` targets in `fuzz/` (run against `lib/` under `--disallow-code-generation-from-strings`); `npm run fuzz:regression` replays the committed corpus (the CI gate). See [fuzz/README.md](fuzz/README.md). `fuzz/` is not in `files`, so it is never published.

## Architecture

The entire implementation is `lib/index.js`, which is also exactly what ships — `lib/` is published as-is, unminified and unbundled (~420 lines, one file by design). `segments(path, j, fns, soft)` parses consecutive segments into closures `(nodes, root) => nodes`; `run()` reduces them over a start nodelist. `query()` calls it in hard mode (`soft` false, errors on junk); the filter parser calls it in soft mode (stops at the first char that cannot start a segment) to parse embedded queries. No JSONPath AST, no code generation.

Bracket contents are scanned by `close()` (matching `]` with nesting and string awareness) and `split()` (top-level commas for unions). `child()`/`kids()` are the only data-access paths. Each segment carries a `sing` flag (singular: one name/index selector, not a descendant) that the filter parser uses to accept or reject a query in ValueType position.

Filters are RFC 9535, parsed by `rfcFilter()` in `selector()`'s `?` branch: a recursive-descent parser (`or`/`and`/`basic`/`primary`) producing `(node, root) => boolean`. Queries run through `segments()`+`run()`; a bare query is an existence test (nodelist length); `cmp()` implements RFC comparison (deep `==` via `deepEq`, `NOTHING` sentinel for absent singular queries, orderings only for same-typed number/string pairs). The five built-in function extensions live in `RFCFN` with arg/return typing; a name not in `RFCFN` is looked up in the caller's registry and treated as a function extension taking value-type args (usable as a value or as a truthiness test — the one deliberate step beyond strict RFC, and it never affects the compliance suite, which only exercises the built-ins). A genuinely malformed filter throws `SyntaxError` at compile time; there is no fallback.

`match()`/`search()` compile through treffer with `{ anchors: true }`. `reTest()` keeps a one-entry positive or negative cache so a document-supplied pattern compiles at most once while filtering a document. Treffer errors and resource-limit failures become false, preserving RFC function behavior.

## Hard constraints

1. **CSP safety is non-negotiable.** Same rules as the siblings: no string-to-code paths, the suite runs under `--disallow-code-generation-from-strings`, and a test scans the source — don't use the words "eval" or "new Function" even in comments.
2. **`child()`, `kids()`, and `deepEq()` are the access boundary.** All data reads go through them; each skips `__proto__`/`constructor`/`prototype` and matches own properties only (`Object.hasOwn`). Never add a read path that bypasses them. Blocked keys silently match nothing everywhere (queries are search, not access), including inside filters — that is intentional and pinned by the safety suite.
3. **`rfcFilter()` is a parser over closures, not a source generator.** It builds `(node, root) => boolean` from pre-existing functions; it never emits or runs source text. It must consume the whole filter and throw `SyntaxError` on anything non-RFC — there is no fallback, so a malformed filter is a hard error, not a reinterpretation.
4. **Treffer is the only runtime dependency.** The JSONPath and filter grammars stay local. Do not add another parser or matcher dependency.
5. **I-Regexp execution must stay bounded.** Keep `match()`/`search()` on treffer with `{ anchors: true }`, preserve the one-entry negative cache and oversized-pattern retention guard, and convert matcher errors to false.
6. Queries must never modify the data (a test snapshots and compares).
7. Size is a soft goal (~3KB min+gzip, excluding treffer). The compliance suite (`npm run cts:update`) is the correctness gate, not size. The budget is a drift alarm, not a per-identifier price: bindings are free to name well because a consumer's minifier mangles them anyway, and unmanglable *property* names like `Loc.value`/`.depth` are worth their bytes — that rename cost 24 B and the limit was raised from 3.75 to 3.9 kB on purpose.

## Omakase pragmatism

Apply this across the whole project: implementation, API design, tests, documentation, dependencies, and tooling. Prefer cohesive defaults and one obvious path over knobs, abstraction, or infrastructure. Test the guarantee users rely on directly, and add complexity only when concrete pressure justifies it. These preferences never weaken the RFC or hard safety constraints.

## Semantics to preserve

- Non-matches return `[]`, never throw: missing keys, out-of-range indexes, wrong node types.
- Compile-time `SyntaxError` for malformed paths and filters. Filters never throw at runtime; a missing or blocked path is simply absent.
- Negative indexes count from the end; slices follow RFC 9535 (negative steps walk backwards, step 0 selects nothing).
- Bracket keys are RFC-typed: a quoted name selects only from objects, an index only from arrays.
- `..` applies the following segment to the node and every descendant, in document order; `all()` carries an ancestor set so cyclic data cannot hang it.
- RFC filters: existence is present-not-truthy (`[?@.a]` matches `{a: null}`), `==` is deep equality, absent singular queries are `NOTHING`. The compliance suite (`test/cts.json`, BSD-2, notice in `test/cts.LICENSE`) pins all of this; `test/compliance.test.js` must report 456 conformant with an empty `DIALECT` ledger.
- I-Regexp follows RFC 9485 plus CTS-compatible `^`/`$` anchors. JavaScript-only escapes and assertions are invalid and return no match. Matching iterates Unicode scalar values; lone surrogates and resource-limit failures return no match.

## Conventions

- Tabs for indentation. Tests use `node:test`: unit and compliance suites live in `test/*.test.js` (`query`, `errors`, `safety`, `compliance`), the type smoke check is `test/types.check.ts`, and browser fixtures live in `test/browser/`.
- Do not mention Symfony in code, comments, or docs.
- Runtime support is Node.js 22.12+ (unflagged `require(esm)`), **ESM only**, plus ES2024 browser environments through a standards-based ESM bundler. There is no CommonJS, direct-script global, or UMD build — shipping two formats would split the diagnostics WeakSet/WeakMap across a `require`/`import` seam, which no config can fix.
- Suggested commit messages must follow Conventional Commits and be at most 80 characters.
- **There is no build.** `lib/` is published verbatim — `files` is just `["lib"]` and `exports` points straight at `lib/index.js`. Consumers get readable source and real stack traces; their own bundler does the minifying. Do not reintroduce one to ship smaller bytes.
- The hand-written declaration lives in `lib/index.d.ts`, beside the code it describes. It is **not** generated: `tsc` cannot keep `@internal` JSDoc typedefs out of emitted declarations ([TypeScript #38444](https://github.com/microsoft/TypeScript/issues/38444)), so generating would publish `Loc`, `Ctx`, `Sel`, `Seg`, `Arg` and `Prim` as API. dts-buddy has the same flaw; ESLint and execa hand-write theirs for the same reason.
- **`checkJs` over `lib/` is what keeps that declaration honest.** `tsconfig.json` type-checks `lib/**/*.js` under full `strict` including `noImplicitAny`. The public types are declared once in `lib/index.d.ts` and pulled into the implementation with `@import`, so a signature that drifts from what ships fails to compile; the traversal types above are local `@typedef`s. `cap()` takes `PadvinderErrorCode`, so a budget code the implementation throws but the declaration omits fails to compile. Verify with: swap a thrown code for a made-up one and confirm `npm run test:types` fails.
- **Budget codes must stay literal at the `cap()` call site.** They used to be derived (`'PADVINDER_' + name.replace(/([A-Z])/g, '_$1').toUpperCase()`), which satisfies `string` and is invisible to tsc — that is exactly how `PADVINDER_MAX_COMPARISONS` shipped undeclared. `CODES` is positionally parallel to `LIMITS`; add to both, and to the union in `lib/index.d.ts`.
- `attw` runs with `--profile esm-only`, which skips the `node10` and `node16-cjs` resolution modes — the two this package deliberately does not support. `node16` (ESM) and `bundler` must stay green.
- Bindings are named for readers: `node`/`value`/`depth` not `x`/`n`/`d`, `children` not `cs`, `nodes` not `ns`, `sliceMatch` not `sl`, `keysLeft`/`keysRight` not `kx`/`ky`, `left`/`right` not `a`/`b`. Internal typedef properties too — `Loc.value`/`.depth`, `Sel.run`/`.topology`. Loop counters stay short. Rename with a scope-aware tool, never `sed`: `s` alone named the raw string, the bracket text and the selector spec in three different functions. Watch shorthand properties — renaming the binding in `{ x }` renames the *property* too.
- **`no-unused-expressions` is suppressed per line, never per glob.** The `cond || fail()` guard idiom trips it 21 times in `lib/index.js`, each carrying its own `// oxlint-disable-line no-unused-expressions`. Do not "tidy" these into one `.oxlintrc.json` override: the rule staying live in that file is what still catches a genuinely dead statement there. Verify by adding `LIMITS;` next to a suppressed line and confirming `npm run lint` fails. The single `no-unused-vars` suppression, on the `spec.a.map((t, x) => …)` line, is a documented oxlint false positive — it misses uses inside a sequence expression.
- New path/filter syntax or safety guards must be reflected in the structured fuzz generator (`fuzz/structured.fuzz.js`): teach the generator the new form and add an oracle or fixed battery for any new invariant.
