# padvinder

A tiny JSONPath engine for JavaScript that implements RFC 9535 — filters included — with a real parser, and never turns query text into JavaScript.

That last part is the reason to care. Filter expressions are JSONPath's classic weak spot: the most-used JavaScript implementation evaluated them by generating and running code, which turned a crafted query into remote code execution ([CVE-2024-21534](https://nvd.nist.gov/vuln/detail/CVE-2024-21534)), followed by bypasses of the first fix. If a query in your system can come from a user, a config file, or a saved report, that is a hole in your application rather than in a library you can patch around. padvinder parses filters — and the regular expressions inside them — into closures, so a query has no route to code execution at all. _Padvinder_ is Dutch for "pathfinder", and also what we call a scout.

- **Spec-complete.** Passes every one of the 703 cases in the official RFC 9535 compliance suite: all 456 valid selectors, and the 247 malformed ones it has to reject.
- **No code generation anywhere.** No `eval`, no `new Function`, and no `RegExp` built from query text. Runs under a strict `script-src 'self'`.
- **Safe regular expressions too.** `match()` and `search()` filters go through [treffer](https://github.com/getquario/treffer), an RFC 9485 I-Regexp matcher backed by a Thompson NFA, so a filter pattern cannot backtrack catastrophically.
- **Bounded traversal.** `maxNodes`, `maxDepth` and `maxResults` cap what an expensive-but-valid query like `$..*` may do; `maxDepth` defaults to 500 so a deeply nested document throws a typed diagnostic instead of overflowing the stack.
- **Tiny.** 4.2 kB minified and brotlied, or 6.5 kB with treffer and waarmerk bundled in.
- **Hardened.** 67 tests at 100% branch coverage, plus three fuzz targets.

```js
import { find } from "padvinder";

const data = {
  store: {
    book: [
      { title: "Moby Dick", price: 8.99 },
      { title: "Sword of Honour", price: 12.99 },
    ],
  },
};

find("$.store.book[?@.price < 10].title", data);
//=> ['Moby Dick']
```

<img src="https://getquario.com/favicon.svg" alt="Quario logo" width="16" height="16" /> <b>padvinder</b> is built by the team behind <b><a href="https://getquario.com?utm_source=github&utm_medium=readme&utm_campaign=padvinder">Quario</a></b>, a declarative reporting engine for JavaScript that renders JSON report definitions to <b>HTML, PDF, workbooks, and Word</b> — without <code>eval</code>.

## Contents

- [Install](#install)
- [Usage](#usage)
- [Is padvinder the right tool?](#is-padvinder-the-right-tool)
- [Related packages](#related-packages)
- [Syntax](#syntax)
- [Filters](#filters)
- [API](#api)
- [Traversal budgets](#traversal-budgets)
- [Safety](#safety)
- [Content Security Policy](#content-security-policy)
- [Environments](#environments)
- [Embedding padvinder](#embedding-padvinder)
- [Contributing](#contributing)
- [License](#license)

## Install

```bash
npm install padvinder
```

Node.js 22 or newer, ESM only. TypeScript declarations ship with the package; nothing extra to install.

## Usage

```js
import { find, query } from "padvinder";

const data = {
  store: {
    book: [
      { title: "Sayings of the Century", price: 8.95, category: "reference" },
      { title: "Sword of Honour", price: 12.99, category: "fiction" },
      { title: "Moby Dick", price: 8.99, category: "fiction" },
    ],
  },
};

// One-shot:
find("$..book[?@.price < 10].title", data);
// => ['Sayings of the Century', 'Moby Dick']

// Compile once, run many times:
const cheap = query('$.store.book[?@.price < 10 && @.category == "fiction"].title');
cheap(data); // => ['Moby Dick']

// Register your own filter functions:
find("$..book[?sale(@)].title", data, { sale: (b) => b.price < 9 });
// => ['Sayings of the Century', 'Moby Dick']
```

A query returns an array of matched **values** — not their paths. A query that matches nothing returns an empty array.

## Is padvinder the right tool?

padvinder is RFC 9535 and nothing else. The RFC is the 2024 standardisation of JSONPath, and it settled a decade of implementations disagreeing about what the same query meant.

**It fits when:**

- Queries come from outside your code — typed by a user, stored in a config file or a saved report, sent over an API — where a query that can execute code is a vulnerability.
- You ship under a strict CSP, or into a runtime where string-to-code is unavailable.
- You want a query to mean the same thing here as in another conforming implementation, in any language.
- You need to bound the work an untrusted query does against an untrusted document. See [Traversal budgets](#traversal-budgets).
- Bundle size is a real constraint.

**Look elsewhere when:**

- You need the _paths_ of the matches, not their values. This returns matched values only; there is no `resultType` and no normalized-path output.
- You depend on pre-RFC extensions. Parent (`^`), `@path`, script expressions like `$..[(@.length-1)]`, and the other conveniences that older JavaScript implementations added are not in RFC 9535 and are not here. Porting an existing query may mean rewriting it.
- You want to write through a path, not just read. Queries never modify your data.
- Your regular expressions need JavaScript syntax. Filters use I-Regexp, so `\d`, lookarounds, and backreferences are rejected — see [Regular expressions](#regular-expressions).
- The data is in a database that already has a query language. JSONPath earns its place on documents you hold in memory.
- You need CommonJS, or Node older than 22. See [Environments](#environments).

## Related packages

- **[treffer](https://github.com/getquario/treffer)** — the bounded RFC 9485 I-Regexp matcher behind `match()` and `search()`, usable on its own if you want ReDoS-proof pattern matching without JSONPath.
- **[xprsn](https://github.com/getquario/xprsn)** and **[sjabloon](https://github.com/getquario/sjabloon)** — an expression language and a template engine from the same family, both CSP-safe, if the untrusted input you are evaluating is a rule or a template rather than a query.

## Syntax

| Selector                            | Meaning                                       |
| ----------------------------------- | --------------------------------------------- |
| `$`                                 | The root                                      |
| `.name`, `['name']`                 | Child property                                |
| `[0]`, `[-1]`                       | Array index, negatives count from the end     |
| `[1:3]`, `[:2]`, `[-2:]`, `[0:4:2]` | Array slice, with optional positive step      |
| `.*`, `[*]`                         | All children                                  |
| `..name`                            | Recursive descent: `name` anywhere below      |
| `[0,2]`, `['a','b']`                | Union of selectors                            |
| `[?expr]`, `[?(expr)]`              | Keep children matching the filter (see below) |

## Filters

Filters follow the RFC 9535 grammar. Comparisons (`==`, `!=`, `<`, `<=`, `>`, `>=`), the logical operators `&&`, `||`, and `!`, and parentheses combine two kinds of operand: literals and _queries_.

```js
find("$.store.book[?@.price < 10]", data);
find("$.store.book[?@.price < $.store.bicycle.price]", data); // $ is the root
find('$.store.book[?@.category == "fiction" && @.price < 20]', data);
find("$.store.book[?!@.sale]", data);
```

A bare query is an existence test, so `[?@.a]` keeps children that have an `a`, including a present `null`. A query used in a comparison is read for its value. A missing path compares as "nothing" and does not throw, so `[?@.a.b == 1]` is safe even when `a` is absent. `==` is deep structural equality.

### Functions

Five ship built in: `length()`, `count()`, `value()`, and the regular-expression tests `match()` (full match) and `search()` (substring). Register your own for anything else and call them with `@` as the current node:

```js
find("$..book[?length(@.title) > 20]", data);
find('$..book[?match(@.isbn, "[0-9]{13}")]', data);
find("$..book[?luhn(@.code)]", data, { luhn: valid }); // your function
```

Your functions receive plain data values and resolve only from the object you pass — a filter cannot reach a function you did not register.

### Regular expressions

`match()` and `search()` use [treffer](https://github.com/getquario/treffer), a bounded [RFC 9485 I-Regexp](https://www.rfc-editor.org/rfc/rfc9485.html) Thompson-NFA matcher. Matching does not backtrack, so a pattern from untrusted input cannot wedge the process, and treffer's own pattern, subject, and work limits apply.

I-Regexp is smaller than JavaScript's syntax: `\d`, `\w`, `\s`, lookarounds, backreferences, and lazy quantifiers are rejected — write `[0-9]` instead of `\d`. `^` and `$` work as anchors here, for compatibility with the JSONPath compliance suite.

Where the pattern came from decides what a bad one does:

- A pattern written as a **string literal in the query** is compiled when the query compiles, and an invalid or over-budget one throws. A typo in query text is an authoring fault, not data.
- A pattern that **arrives from data** follows RFC 9535 and simply does not match. A malformed value in a document is not a reason to fail the query.

The thrown diagnostic keeps treffer's class and `TREFFER_*` code, so a malformed pattern stays distinguishable from one over budget. [EMBEDDING.md](EMBEDDING.md#delegated-pattern-diagnostics) has the details for hosts that authenticate errors.

## API

### `query(path, functions?, options?)`

Compiles the query and returns a runner `(data) => matches[]`. Malformed paths and invalid filter expressions throw a `SyntaxError` at compile time, so a compiled query is one that parses.

The runner also carries frozen compile-time metadata — `functions` (the caller-registered extensions the query calls, RFC built-ins excluded), `paths` (what the query depends on), and `singular` (whether it can select more than one node). The last two are aimed at hosts; see [EMBEDDING.md](EMBEDDING.md#paths-what-a-query-depends-on).

```js
query("$..book[?sale(@)]", { sale: () => true }).functions; // => ['sale']
```

### `find(path, data, functions?, options?)`

Shorthand for `query(path, functions, options)(data)`. Compiles every call, so prefer `query` in a loop.

### Errors

Errors keep their native `SyntaxError`, `TypeError`, or `RangeError` class. A query that does not parse throws a `SyntaxError` with a `code` naming what kind of mistake it was, and a span:

```js
import { isDiagnostic, query } from "padvinder";

try {
  query("$.a[?(nope(@))]");
} catch (error) {
  if (!isDiagnostic(error)) throw error;
  error.code; // => 'PADVINDER_UNKNOWN_FUNCTION'
  "$.a[?(nope(@))]".slice(error.start, error.end); // => 'nope'
}
```

Spans are offsets into the query string you passed, so `path.slice(start, end)` is the offending text. A fault inside a filter reports where it is in the whole query, not where it is in the filter body — however deeply nested it is. A selector that does not parse spans that selector rather than the whole bracket; a bad escape in a string literal spans the escape rather than the literal; an unclosed bracket points at the bracket that was never closed; a query that ends early gets an empty span at the end.

A code names the category of mistake, not the exact fault — which of several ways a string literal is malformed is what the message says. Five categories are a single named mistake:

| Code                         | Means                                                                |
| ---------------------------- | -------------------------------------------------------------------- |
| `PADVINDER_MISSING_ROOT`     | the query does not start at `$`                                      |
| `PADVINDER_BAD_SELECTOR`     | a bracket selector is neither a quoted name nor an integer           |
| `PADVINDER_UNCLOSED_BRACKET` | a `[` was never closed                                               |
| `PADVINDER_BAD_STRING`       | a quoted name or string literal is malformed                         |
| `PADVINDER_UNKNOWN_FUNCTION` | a filter called a name that is not built in and not in your registry |

`PADVINDER_SYNTAX` is the rest: an unexpected character in a path, and a filter body that does not parse. Those are open-ended — there is no finite set of ways to write something that is not a query — so they share one category rather than being enumerated.

The budget codes are `PADVINDER_MAX_NODES`, `PADVINDER_MAX_DEPTH`, `PADVINDER_MAX_RESULTS`, and `PADVINDER_MAX_COMPARISONS` (a fixed internal cap of one million steps on a single deep-equality comparison), and a bad pattern literal carries a `TREFFER_*` code instead. Option faults are about the call rather than a place in the query, so their `TypeError` and `RangeError` carry neither code nor span.

Errors from caller-provided coercion hooks, accessors, or function extensions pass through unchanged. `isDiagnostic(error)` tells padvinder's own from those; it authenticates by identity rather than by shape, which matters if you embed padvinder — see [EMBEDDING.md](EMBEDDING.md#diagnostic-identity), which also covers `relocate`.

## Traversal budgets

An untrusted query against an untrusted document can be expensive without being invalid: `$..*` over a deep document visits everything. Three per-execution budgets bound it, passed as the last argument:

```js
find("$..book[*]", data, {}, { maxNodes: 10_000, maxDepth: 64, maxResults: 1_000 });
```

| Option       | Bounds                                                      | Default |
| ------------ | ----------------------------------------------------------- | ------- |
| `maxNodes`   | Locations visited, across the main query and its subqueries | ∞       |
| `maxDepth`   | Child edges from each query start, at depth zero            | **500** |
| `maxResults` | The final nodelist of each main or embedded query           | ∞       |

`maxDepth` defaults to 500 so a deeply nested untrusted document throws a typed diagnostic instead of overflowing the native stack. Each value must be a non-negative safe integer, or `Infinity` — the deliberate spelling for "this budget, unbounded", so `maxDepth: Infinity` opts back out.

Exceeding a budget throws a `RangeError` with `code`, `limit`, and `actual`. A compiled runner starts with fresh counters on every call, so budgets are per execution, not per runner.

These bound work inside the engine, not the wall clock of your application. [SECURITY.md](SECURITY.md) covers what that does and does not buy you, and the process for reporting a vulnerability.

## Safety

- Queries read the data you pass in and never modify it.
- `__proto__`, `constructor`, and `prototype` never match, in paths or in filters. Prototype-chain properties are invisible: matching is own-properties only, so a filter like `[?@.constructor]` finds nothing and never reaches `Object.prototype`.
- I-Regexp matching uses bounded NFA simulation instead of a backtracking engine.
- Registered functions resolve only from what you provide, and receive plain data values as arguments.

## Content Security Policy

padvinder works under `script-src 'self'` with no `unsafe-eval`. Paths and filters compile to a chain of closures; query text is never turned into JavaScript. The test suite runs under `node --disallow-code-generation-from-strings`, which throws on any string-to-code construct the same way a strict CSP does.

Not generating code costs some speed against implementations that do. See the [comparison benchmarks](bench/comparison/) for cold-compile and hot-run numbers.

## Environments

Node.js 22 and newer, ESM only. Browser use is supported through a standards-based ESM bundler in environments supporting ES2024. Direct `<script>` globals, UMD, and CommonJS builds are not provided.

Shipping CommonJS alongside ESM would put two copies of the core in any process that mixed `require` and `import`. Each copy would have its own diagnostic identity, so `isDiagnostic` would return `false` across the seam.

TypeScript declarations are hand-written and ship in the package; `npm run check` runs `attw` against them.

## Embedding padvinder

If you read queries out of a larger document — a `data` property in a report schema, a field in a config file — [EMBEDDING.md](EMBEDDING.md) covers the surface built for that: `paths` dependency topologies, `singular`, diagnostic identity, relocating a fault into your own coordinates, and how a delegated pattern diagnostic behaves.

## Contributing

```bash
git clone https://github.com/getquario/padvinder.git
cd padvinder
npm install
git config core.hooksPath .githooks   # enable the commit-msg hook
npm run check
```

`npm run check` is the local gate: formatting, lint, dead-code and dependency checks, the size budget, the unit and type suites, the fuzz regression corpus, and the browser CSP run. It is the same gate CI runs, so a green `check` locally means a green pull request.

The RFC 9535 compliance suite is vendored at `test/cts.json`; `npm run cts:update` refreshes it from upstream. Conventions for this repo live in [AGENTS.md](AGENTS.md).

## License

Copyright 2026 Robin van der Vleuten

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
