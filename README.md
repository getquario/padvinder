# padvinder

A tiny, CSP-safe JSONPath engine for JavaScript. **~3KB min+gzip, one dependency. Passes all 456 valid-selector cases of the official RFC 9535 compliance suite.**

[![NPM version](https://img.shields.io/npm/v/padvinder.svg)](https://www.npmjs.com/package/padvinder)
[![Build Status](https://github.com/getquario/padvinder/actions/workflows/test.yml/badge.svg)](https://github.com/getquario/padvinder/actions/workflows/test.yml)
[![NPM downloads](https://img.shields.io/npm/dm/padvinder.svg)](https://www.npmjs.com/package/padvinder)
[![Apache-2.0 license](https://img.shields.io/github/license/getquario/padvinder.svg)](https://github.com/getquario/padvinder/blob/main/LICENSE)

<a href="https://webstronauts.com?utm_source=github&utm_medium=readme&utm_campaign=padvinder">
	<picture>
		<img src="https://webstronauts.com/images/sponsored-by.svg" alt="Sponsored by The Webstronauts" width="200" height="65">
	</picture>
</a>

_Padvinder_ is Dutch for "pathfinder", and also what we call a scout. It implements RFC 9535 JSONPath, filters included, with a real parser instead of the generated code that filter evaluation usually relies on. There is no `eval` and no `new Function`, so a query cannot smuggle code into your application, and the engine runs under a strict Content Security Policy.

## Install

```bash
npm install padvinder
```

Node.js 22 or newer, ESM only.

## Usage

```js
import { query, find } from "padvinder";

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
```

## API

### `query(path, functions?, options?)`

Compiles the query and returns a runner `(data) => matches[]`. Malformed paths and invalid filter expressions throw a `SyntaxError` at compile time. A query that matches nothing returns an empty array.

The runner exposes deeply frozen compile-time metadata:

- `functions` lists referenced caller-registered filter extensions in first-seen order. RFC built-ins are excluded.
- `paths` lists deduplicated dependency topologies for the main query and embedded `$`/`@` filter queries. Each path is an anchor-first tuple followed by selector tuples such as `['name', 'store']`, `['index', 0]`, `['wildcard']`, `['union', ...selectors]`, `['slice', start, end, step]`, `['filter']`, or `['descendant', selector]`.

Dynamic tuples describe selection topology, not exact field locations or a lossless query AST. Filter predicate text and parent links for embedded queries are intentionally omitted; selector order and union duplicates are preserved.

The runner also exposes `isDiagnostic(error)`. This narrower predicate returns `true` only for runtime traversal-budget errors created by that compiled runner. Repeated calls share the runner origin; another runner, even from the same module instance, does not authenticate the error.

### `find(path, data, functions?, options?)`

Shorthand for `query(path, functions)(data)`.

Traversal budgets are optional host controls. Without them, queries remain unlimited. `maxNodes` bounds locations visited across the main query and filter subqueries, `maxDepth` bounds child edges from each query start at depth zero, and `maxResults` bounds the final nodelist of each main or embedded query:

```js
const options = { maxNodes: 10_000, maxDepth: 64, maxResults: 1_000 };
find("$..book[*]", data, {}, options);
```

Each value must be a non-negative safe integer. Exceeding a budget throws a `RangeError` with `code`, `limit`, and `actual` properties. Codes are `PADVINDER_MAX_NODES`, `PADVINDER_MAX_DEPTH`, and `PADVINDER_MAX_RESULTS`. A compiled runner starts with fresh counters on every call.

Errors created by padvinder keep their `SyntaxError`, `TypeError`, or `RangeError` class. Use the exported `isDiagnostic(error)` to authenticate package origin. The check is local to one installed module instance: copied properties and errors from another copy do not pass. It covers compile-time diagnostics, for which no runner is returned, and runtime diagnostics from every runner in that module instance.

Errors from caller-provided coercion hooks, accessors, or function extensions pass through unchanged. Package authentication still identifies where an error was created when caller code rethrows an authentic padvinder diagnostic, while `runner.isDiagnostic(error)` rejects it unless that runner created the runtime fault. The one-shot `find()` API does not expose its temporary runner; use `query()` when runner-scoped authentication is required.

### Compile-time diagnostics

A query that does not parse throws a `SyntaxError` carrying `code` — always `PADVINDER_SYNTAX` — and a span:

- `start`: the zero-based offset into the query;
- `end`: the exclusive offset.

Spans are offsets into the query string you passed in, so `path.slice(start, end)` is the offending text. A fault inside a filter reports where it is in the whole query, not where it is in the filter: `$.a[?(nope(@))]` points at `nope`, not at offset 1 of the filter body. That holds however deep the fault is — a relative path inside a filter, a string literal inside that path, a filter nested inside another filter. A selector that does not parse spans that selector rather than the whole bracket, a bad escape or character in a string literal spans that escape or character rather than the whole literal, an unclosed bracket points at the bracket that was never closed, and a query that ends early gets an empty span at the end.

Option faults are about the call rather than a place in the query, so the `TypeError` and `RangeError` they throw carry neither a code nor a span. Traversal budgets are exceeded at run time, where the query parsed fine; those keep `code`, `limit`, and `actual`, and have no span.

### Relocating a diagnostic

An embedder that reads queries out of a larger document — a `data` property in a report schema, a field in a config file — reports the fault in its own coordinates, not the query's. `relocate(diagnostic, { prefix, offset })` returns the copy to re-throw:

```js
import { isDiagnostic, query, relocate } from "padvinder";

try {
  query(schema.data);
} catch (error) {
  if (!isDiagnostic(error)) throw error;
  throw relocate(error, { prefix: "data: " });
}
```

The copy keeps the original's class, prepends `prefix` to the message verbatim, shifts `start` and `end` by `offset` when there is a span, and carries every other field across. It is registered exactly as the original was, so it passes `isDiagnostic` and — for a runtime fault — the runner's own `isDiagnostic` too. The original is left untouched. Relocation belongs here rather than in the embedder because authentication is by identity: a copy an embedder builds itself cannot be authenticated, and a field added to a diagnostic here would be a field the embedder's copy silently drops. Passing anything but a padvinder diagnostic throws a `TypeError`.

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

Filters follow the RFC 9535 grammar. Comparisons (`==`, `!=`, `<`, `<=`, `>`, `>=`), the logical operators `&&`, `||`, and `!`, and parentheses combine two kinds of operand: literals and _queries_. A bare query is an existence test, so `[?@.a]` keeps children that have an `a`, including a present `null`. A query used in a comparison is read for its value. A missing path compares as "nothing" and does not throw, so `[?@.a.b == 1]` is safe even when `a` is absent. `==` is deep structural equality.

```js
find("$.store.book[?@.price < 10]", data);
find("$.store.book[?@.price > $.store.bicycle.price]", data); // $ is the root
find('$.store.book[?@.category == "fiction" && @.price < 20]', data);
find("$.store.book[?!@.sale]", data);
```

Five functions ship built in: `length()`, `count()`, `value()`, and the regular-expression tests `match()` (full match) and `search()` (substring). Register your own for anything else, and call them from a filter with `@` as the current node:

```js
find("$.book[?length(@.title) > 20]", data);
find('$.book[?match(@.isbn, "[0-9]{13}")]', data);
find("$.book[?luhn(@.code)]", data, { luhn: valid }); // your function
```

`match()` and `search()` use [treffer](https://github.com/getquario/treffer), a bounded [RFC 9485 I-Regexp](https://www.rfc-editor.org/rfc/rfc9485.html) Thompson-NFA matcher. Matching does not backtrack. `^` and `$` are supported as anchors for compatibility with the JSONPath compliance suite. JavaScript-only syntax such as `\d`, lookarounds, backreferences, and lazy quantifiers is rejected; use `[0-9]` in place of `\d`.

Treffer enforces its documented pattern, subject, NFA, and work limits. padvinder authenticates errors created by Treffer and maps its syntax and resource diagnostics to no match, as required by RFC 9535. Unexpected errors are not misclassified or swallowed. See [Treffer's documentation](https://github.com/getquario/treffer#errors-and-limits) for the current codes, limits, and complexity bounds.

## Content Security Policy

padvinder works under `script-src 'self'` with no `unsafe-eval`. Paths and filters compile to a chain of closures. Query text is never turned into JavaScript.

This matters for JSONPath specifically because filter expressions are the classic weak spot: jsonpath-plus evaluated them by executing generated code, which led to remote code execution via crafted queries ([CVE-2024-21534](https://nvd.nist.gov/vuln/detail/CVE-2024-21534)) and follow-up bypasses. padvinder parses filters and regular expressions without executing query text. The test suite runs under `node --disallow-code-generation-from-strings`, which throws on any string-to-code construct the same way a strict CSP does. See the [comparison benchmarks](bench/comparison/) for cold-compile and hot-run comparisons.

## Safety

- Queries read the data you pass in and never modify it.
- `__proto__`, `constructor`, and `prototype` never match, in paths or in filters. Prototype-chain properties are invisible: matching is own-properties only, so a filter like `[?@.constructor]` finds nothing and never reaches `Object.prototype`.
- I-Regexp matching uses bounded NFA simulation instead of a backtracking engine.
- Registered functions resolve only from what you provide, and receive plain data values as arguments.

## Environments

Node.js 22 and newer, ESM only. Browser use is supported through a standards-based ESM bundler in environments supporting ES2024. Direct `<script>` globals, UMD, and CommonJS builds are not provided.

Shipping CommonJS alongside ESM would put two copies of the core in any process that mixed `require` and `import`. Each copy would have its own diagnostic identity, so `isDiagnostic` would return `false` across the seam.

## Contributing

```bash
git clone https://github.com/getquario/padvinder.git
cd padvinder
npm install
npm run check
```

`npm run check` is the local gate. Conventions for this repo live in [AGENTS.md](AGENTS.md).

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
