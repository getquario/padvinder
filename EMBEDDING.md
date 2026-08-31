# Embedding padvinder

For hosts that read queries out of a larger document — a `data` property in a
report schema, a field in a config file, a mapping rule in an integration — and
that need to know what a query depends on, bind a result as a scalar, or report a
fault in their own coordinates.

None of this is needed to run queries. [README.md](README.md) covers the ordinary
surface: `query`, `find`, the syntax, the filters, and the budgets.

- [`paths`: what a query depends on](#paths-what-a-query-depends-on)
- [`singular`: one node or a list](#singular-one-node-or-a-list)
- [Diagnostic identity](#diagnostic-identity)
- [`relocate(diagnostic, options)`](#relocatediagnostic-options)
- [Delegated pattern diagnostics](#delegated-pattern-diagnostics)

## `paths`: what a query depends on

A compiled runner exposes `paths`: deeply frozen, deduplicated dependency
topologies for the main query and for every embedded `$`/`@` filter query.

```js
query("$.store.book[?@.price < 10].title").paths;
// => [
//   ['$', ['name', 'store'], ['name', 'book'], ['filter'], ['name', 'title']],
//   ['@', ['name', 'price']],
// ]
```

Each entry is an anchor (`'$'` or `'@'`) followed by selector tuples:

| Tuple                         | Selector |
| ----------------------------- | -------- |
| `['name', 'store']`           | `.store` |
| `['index', 0]`                | `[0]`    |
| `['wildcard']`                | `[*]`    |
| `['union', ...selectors]`     | `[0,2]`  |
| `['slice', start, end, step]` | `[1:3]`  |
| `['filter']`                  | `[?…]`   |
| `['descendant', selector]`    | `..name` |

This answers questions a host asks _before_ running anything: which fields does
this stored query read, so I can fetch only those; which saved queries touch the
field I am about to rename; does this query reach outside the subtree I am
willing to expose.

What it is not: a lossless AST. Filter predicate text is omitted, and so are
parent links for embedded queries — you learn that a filter exists at a position
and what it reads, not what it decides. Selector order and union duplicates are
preserved, because both change what a query selects. Treat `paths` as a
dependency topology, not as a query you can rebuild.

## `singular`: one node or a list

`singular` is `true` when the query is a singular query per RFC 9535 — every
segment selects at most one node, so the whole query selects at most one.

```js
query("$.store.book[0].title").singular; // => true
query("$..book[*]").singular; // => false
```

A host that binds query results into a data model asks this before deciding
whether a result is a scalar or a list. Without it, a query that happens to
return one node this time would bind as a scalar and then break on the document
where it returns two.

## Diagnostic identity

`isDiagnostic(error)` returns `true` only for errors created by the same
padvinder module instance. It is an identity check, not a shape check: copied
properties do not pass, and a diagnostic from another installed copy returns
`false`. It covers compile-time diagnostics — for which no runner exists — and
runtime diagnostics from every runner in that instance.

Each compiled runner also carries its own `isDiagnostic(error)`, `true` only for
runtime traversal-budget errors created by _that_ runner. Another runner from the
same module instance does not authenticate the error. An embedder holding many
compiled queries asks the one that just ran, so a budget error that leaked from
an unrelated query is not attributed to this one. Repeated calls to one runner
share its origin.

`find()` does not expose its temporary runner, so use `query()` when you need
runner-scoped authentication.

Errors from caller-provided coercion hooks, accessors, or function extensions
pass through unchanged and are never annotated. Package-level authentication
still identifies where an error was created when your code rethrows an authentic
padvinder diagnostic.

The identity machinery and the `Diagnostic` / `Relocation` types come from
[waarmerk](https://www.npmjs.com/package/waarmerk).

## `relocate(diagnostic, options)`

`relocate(diagnostic, { prefix, offset })` — or `{ prefix, span }` — returns the
copy to re-throw:

```js
import { isDiagnostic, query, relocate } from "padvinder";

try {
  query(schema.data);
} catch (error) {
  if (!isDiagnostic(error)) throw error;
  throw relocate(error, { prefix: "data: " });
}
```

The copy keeps the original's class, prepends `prefix` to the message verbatim,
moves the span when there is one, and carries every other field across. It is
registered exactly as the original was, so it passes `isDiagnostic` and — for a
runtime fault — the runner's own `isDiagnostic` too. The original is left
untouched. Passing anything but a padvinder diagnostic throws a `TypeError`.

`offset` shifts the span, which is right whenever the query was a verbatim slice
of your text. It is wrong when your text was decoded first — a query read out of
a JSON string literal, where an escape makes every later offset slide. Pass
`span` instead to name the region the query came from; it replaces the span
outright and wins when both are given. Neither option adds a span to a diagnostic
that had none, so a traversal-budget error stays spanless.

Relocation lives here rather than in the embedder because authentication is by
identity: a copy an embedder builds itself cannot be authenticated, and a field
added to a diagnostic here would be a field the embedder's copy silently drops.

## Delegated pattern diagnostics

`match()` and `search()` patterns are [treffer](https://github.com/getquario/treffer)
I-Regexps, and where the pattern came from decides what a bad one does. The rule
is in the [README](README.md#regular-expressions); this is what it means for a
host authenticating errors.

A pattern written as a **string literal in the query** is compiled when the query
compiles, and an invalid or over-budget one throws with the code and class
treffer gave it — `TREFFER_SYNTAX` as a `SyntaxError`, a `TREFFER_MAX_*` budget
as a `RangeError`, with `limit` and `actual` intact. The span is padvinder's,
covering the literal in the query:

```js
query('$.a[?match(@.b, "\\d")]');
// SyntaxError  code: 'TREFFER_SYNTAX'  start: 16  end: 21
```

Treffer counts from the start of the decoded pattern, and a JSON escape slides
every offset after it, so padvinder replaces the span rather than shifting it.
An over-budget literal carries a span too, even though a resource limit has no
position inside the pattern — the literal still has one in the query.

As thrown, such a diagnostic authenticates through padvinder's `isDiagnostic`.
`PadvinderDiagnostic["code"]` is widened with `TrefferErrorCode`, and that type is
re-exported from `padvinder`, so a host can name these codes without taking a
treffer dependency of its own.

A pattern that **arrives from data** keeps RFC 9535 semantics instead: padvinder
authenticates the error treffer created and maps its syntax and resource
diagnostics to no match for that node. Unexpected errors are never misclassified
or swallowed.
