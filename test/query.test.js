import assert from "node:assert/strict";
import test from "node:test";
import { isDiagnostic as isPattern } from "treffer";
import { find, isDiagnostic, query } from "../lib/index.js";

const data = {
  store: {
    book: [
      { category: "reference", author: "Nigel Rees", title: "Sayings of the Century", price: 8.95 },
      { category: "fiction", author: "Evelyn Waugh", title: "Sword of Honour", price: 12.99 },
      { category: "fiction", author: "Herman Melville", title: "Moby Dick", price: 8.99 },
      {
        category: "fiction",
        author: "J. R. R. Tolkien",
        title: "The Lord of the Rings",
        price: 22.99,
      },
    ],
    bicycle: { color: "red", price: 19.95 },
  },
};

test("child access", () => {
  assert.deepStrictEqual(find("$.store.bicycle.color", data), ["red"]);
  assert.deepStrictEqual(find("$.store.book[0].title", data), ["Sayings of the Century"]);
  assert.deepStrictEqual(find("$.store.book[-1].title", data), ["The Lord of the Rings"]);
  assert.deepStrictEqual(find("$.store['bicycle']['color']", data), ["red"]);
  assert.deepStrictEqual(find('$["store"]["bicycle"]', data), [{ color: "red", price: 19.95 }]);
  assert.deepStrictEqual(find("$.store.book[9].title", data), [], "out of bounds matches nothing");
  assert.deepStrictEqual(find("$.nope.deeper", data), [], "missing paths match nothing");
});

test("wildcards", () => {
  assert.deepStrictEqual(find("$.store.book[*].author", data), [
    "Nigel Rees",
    "Evelyn Waugh",
    "Herman Melville",
    "J. R. R. Tolkien",
  ]);
  assert.deepStrictEqual(
    find("$.store.*.price", data).sort((a, b) => a - b),
    [19.95],
    "dot wildcard over object values",
  );
  assert.deepStrictEqual(find("$.store.bicycle.*", data), ["red", 19.95]);
});

test("recursive descent", () => {
  assert.deepStrictEqual(find("$..author", data), [
    "Nigel Rees",
    "Evelyn Waugh",
    "Herman Melville",
    "J. R. R. Tolkien",
  ]);
  assert.deepStrictEqual(find("$..price", data), [8.95, 12.99, 8.99, 22.99, 19.95]);
  assert.deepStrictEqual(find("$..book[0].title", data), ["Sayings of the Century"]);
});

test("slices", () => {
  const titles = (b) => b.map((x) => x.title);
  assert.deepStrictEqual(titles(find("$.store.book[1:3]", data)), ["Sword of Honour", "Moby Dick"]);
  assert.deepStrictEqual(titles(find("$.store.book[:2]", data)), [
    "Sayings of the Century",
    "Sword of Honour",
  ]);
  assert.deepStrictEqual(titles(find("$.store.book[-2:]", data)), [
    "Moby Dick",
    "The Lord of the Rings",
  ]);
  assert.deepStrictEqual(
    titles(find("$.store.book[0:4:2]", data)),
    ["Sayings of the Century", "Moby Dick"],
    "step",
  );
});

test("quoted keys unescape", () => {
  assert.deepStrictEqual(find("$['it\\'s']", { "it's": 1 }), [1], "escaped single quote");
  assert.deepStrictEqual(
    find('$["say \\"hi\\""]', { 'say "hi"': 2 }),
    [2],
    "escaped double quotes",
  );
  assert.deepStrictEqual(
    find("$['back\\\\slash']", { "back\\slash": 3 }),
    [3],
    "escaped backslash",
  );
  assert.deepStrictEqual(
    find(String.raw`$['say "hi"']`, { 'say "hi"': 4 }),
    [4],
    "raw opposite quote",
  );
  assert.deepStrictEqual(
    find(String.raw`$['\uD83D\uDE00']`, { "😀": 5 }),
    [5],
    "escaped surrogate pair",
  );
  assert.deepStrictEqual(find("$['😀']", { "😀": 6 }), [6], "raw supplementary scalar");
  assert.deepStrictEqual(find("$['a,b']", { "a,b": 4 }), [4], "comma inside quotes is not a union");
  assert.deepStrictEqual(find("$['spaced key'].x", { "spaced key": { x: 5 } }), [5]);
});

test("unions", () => {
  assert.deepStrictEqual(find("$.store.book[0,2].title", data), [
    "Sayings of the Century",
    "Moby Dick",
  ]);
  assert.deepStrictEqual(find("$.store.bicycle['color','price']", data), ["red", 19.95]);
});

test("filters", () => {
  assert.deepStrictEqual(find("$.store.book[?@.price < 10].title", data), [
    "Sayings of the Century",
    "Moby Dick",
  ]);
  assert.deepStrictEqual(
    find("$.store.book[?(@.price < 10)].title", data),
    ["Sayings of the Century", "Moby Dick"],
    "parens optional",
  );
  assert.deepStrictEqual(find('$..book[?@.category == "fiction" && @.price < 20].title', data), [
    "Sword of Honour",
    "Moby Dick",
  ]);
  assert.deepStrictEqual(find('$..book[?@.category == "reference" || @.price > 20].title', data), [
    "Sayings of the Century",
    "The Lord of the Rings",
  ]);
  assert.deepStrictEqual(
    find("$.store.book[?!(@.price < 10)].title", data),
    ["Sword of Honour", "The Lord of the Rings"],
    "negation",
  );
  assert.deepStrictEqual(find("$.store.book[?search(@.title, '^S')].title", data), [
    "Sayings of the Century",
    "Sword of Honour",
  ]);
  assert.deepStrictEqual(
    find("$.store.book[?@.missing.deep].title", data),
    [],
    "missing path is absent, not an error",
  );
});

test("RFC filter semantics", () => {
  assert.deepStrictEqual(
    find("$.list[?@.a]", { list: [{ a: null }, { a: false }, {}] }),
    [{ a: null }, { a: false }],
    "existence matches present-but-falsy values",
  );
  assert.deepStrictEqual(
    find("$.list[?@.a == @.b].n", {
      list: [
        { n: 1, a: [1, [2]], b: [1, [2]] },
        { n: 2, a: [1], b: [2] },
      ],
    }),
    [1],
    "== is deep equality",
  );
  assert.deepStrictEqual(
    find("$.list[?@.missing == @.gone].n", { list: [{ n: 1 }] }),
    [1],
    "Nothing equals Nothing",
  );
  assert.deepStrictEqual(
    find("$.list[?@.a.b == 1].n", { list: [{ n: 1, a: { b: 1 } }, { n: 2 }] }),
    [1],
    "missing paths compare as Nothing instead of throwing",
  );
  assert.deepStrictEqual(
    find("$.list[?count(@.*) > 2].n", { list: [{ n: 1, a: 1, b: 2, c: 3 }, { n: 2 }] }),
    [1],
    "count() over a subquery nodelist",
  );
  assert.deepStrictEqual(find("$[?@[?@ > 1]]", [[1], [1, 2], [0]]), [[1, 2]], "nested filters");
  assert.deepStrictEqual(
    find("$.list[?length(@.name) == 5].name", { list: [{ name: "Robin" }, { name: "Bo" }] }),
    ["Robin"],
  );
  assert.deepStrictEqual(
    find('$.list[?match(@.sku, "X-[0-9]+")].sku', { list: [{ sku: "X-42" }, { sku: "Y-1" }] }),
    ["X-42"],
  );
});

test("I-Regexp grammar and Unicode semantics", () => {
  const match = (p, values) => find("$[?match(@, " + JSON.stringify(p) + ")]", values);
  const search = (p, values) => find("$[?search(@, " + JSON.stringify(p) + ")]", values);

  assert.deepStrictEqual(
    match("(ab|cd)+", ["ab", "abcd", "cdab", "a"]),
    ["ab", "abcd", "cdab"],
    "groups and alternation",
  );
  assert.deepStrictEqual(
    match("a{2,4}", ["a", "aa", "aaaa", "aaaaa"]),
    ["aa", "aaaa"],
    "range quantifier",
  );
  assert.deepStrictEqual(match("a|", ["", "a", "aa"]), ["", "a"], "empty alternative");
  assert.deepStrictEqual(match("", ["", "a"]), [""], "empty full match");
  assert.deepStrictEqual(search("", ["", "a"]), ["", "a"], "empty search");
  assert.deepStrictEqual(search("^ab", ["abx", "zab"]), ["abx"], "^ anchors the subject");
  assert.deepStrictEqual(search("ab$", ["zab", "abz"]), ["zab"], "$ anchors the subject");
  assert.deepStrictEqual(match("[-a]+", ["a-a", "bbb"]), ["a-a"], "leading hyphen in class");
  assert.deepStrictEqual(match("[^a]+", ["bbb", "aba"]), ["bbb"], "negated class");
  assert.deepStrictEqual(match("[\\[]+", ["[[", "]"]), ["[["], "escaped opening bracket");
  assert.deepStrictEqual(match("[\\]]+", ["]]", "["]), ["]]"], "escaped closing bracket");
  assert.deepStrictEqual(match("[\\\\]+", ["\\", "/"]), ["\\"], "escaped backslash");
  assert.deepStrictEqual(
    match("[\\n-\\r]+", ["\n\f\r", "\t"]),
    ["\n\f\r"],
    "escaped range endpoints",
  );
  assert.deepStrictEqual(match("\\p{Lu}+", ["ABC", "Abc", "Ä"]), ["ABC", "Ä"], "Unicode property");
  assert.deepStrictEqual(match("\\P{Lu}+", ["abc", "ABC"]), ["abc"], "Unicode property complement");
  assert.deepStrictEqual(
    match(".", ["x", "\u2028", "\n", "😀"]),
    ["x", "\u2028", "😀"],
    "dot uses Unicode scalars and excludes newline",
  );
});

// Curried like budgetError below: instance, provenance, code and the span of
// the pattern literal, in one predicate all three literal-fault sites share.
//
// The diagnostic belongs to both packages. Treffer decided what is wrong with
// the pattern, so its class and its `TREFFER_*` code survive — a host can still
// tell a malformed pattern from one over budget. Padvinder decided where in the
// query that is, because Treffer's own offsets are into the decoded pattern and
// a JSON escape slides every one of them.
// Both packages vouch for it, and the code is the one Treffer decided on.
const delegated = (e) => isDiagnostic(e) && isPattern(e) && e.code.startsWith("TREFFER_");
const patternFault =
  (at, len, Kind = SyntaxError) =>
  (e) =>
    e instanceof Kind && delegated(e) && patternSpan(e, at, len);
const patternSpan = (e, at, len) => e.start === at && e.end === at + len;

test("an invalid literal pattern is a located compile fault", () => {
  const bad = (p, Kind, lit = JSON.stringify(p)) => {
    const q = "$[?match(@, " + lit + ")]";
    assert.throws(() => query(q), patternFault(q.indexOf(lit), lit.length, Kind), p);
  };
  // A malformed pattern is Treffer's SyntaxError; one over budget is its
  // RangeError. Flattening both into one PADVINDER_SYNTAX is what this stopped
  // doing, so the class is part of what each case pins.
  for (const [p, Kind] of [
    ["\\d+", SyntaxError],
    ["(?=a)", SyntaxError],
    ["(a)\\1", SyntaxError],
    ["a+?", SyntaxError],
    ["[^]", SyntaxError],
    ["[[]", SyntaxError],
    ["[a[b]", SyntaxError],
    ["[z-a]", SyntaxError],
    ["a{1025}", RangeError],
    ["(".repeat(65) + "a" + ")".repeat(65), RangeError],
    ["a".repeat(4097), RangeError],
    ["a{0001024}", RangeError],
  ])
    bad(p, Kind);
  // The budget metadata survives whole, which the flattening used to drop.
  assert.throws(
    () => query('$[?match(@, "a{1025}")]'),
    (e) => e.code === "TREFFER_MAX_REPETITIONS" && e.limit === 1024 && e.actual === 1025,
  );
  assert.throws(
    () => query("$[?search(@, '(')]"),
    patternFault(13, 3),
    "search validates too, single-quoted literals included",
  );
  const nested = '$.rows[?@.items[?match(@.x, "(")]]';
  assert.throws(
    () => query(nested),
    patternFault(nested.indexOf('"'), 3),
    "a literal in a nested filter locates through the composed base",
  );
  assert.deepStrictEqual(
    find("$[?match(@, 1)]", ["a"]),
    [],
    "a non-string pattern literal stays a soft row-time false",
  );
});

test("invalid patterns from data still match nothing", () => {
  const run = (p) => find("$.values[?match(@, $.p)]", { values: ["a", "aaa"], p });
  for (const p of ["\\d+", "(", "a{1025}", "a".repeat(4097)]) {
    assert.deepStrictEqual(run(p), [], p);
  }
  assert.deepStrictEqual(
    find("$.values[?match(@, $.p)]", { values: ["a"], p: "a" }),
    ["a"],
    "a valid data pattern still matches",
  );
});

test("runtime-budget and edge I-Regexp behavior stays soft", () => {
  const run = (p, values = ["a", "aaa"]) => find("$[?match(@, " + JSON.stringify(p) + ")]", values);
  assert.throws(() => run("\ud800"), SyntaxError, "lone surrogate is not a valid filter string");
  assert.deepStrictEqual(
    run("(".repeat(64) + "a" + ")".repeat(64)),
    ["a"],
    "deepest group nesting compiles",
  );
  assert.deepStrictEqual(
    find('$[?match(@, "a{1024}")]', ["a".repeat(1024)]),
    ["a".repeat(1024)],
    "largest range compiles",
  );
  assert.deepStrictEqual(
    find("$[?match(@, " + JSON.stringify("a".repeat(4094)) + ")]", ["a".repeat(4094)]),
    ["a".repeat(4094)],
    "largest NFA compiles",
  );
  assert.deepStrictEqual(
    find("$[?match(@, " + JSON.stringify("[" + "a".repeat(4094) + "]") + ")]", ["a"]),
    ["a"],
    "largest pattern compiles",
  );
});

test("every authenticated Treffer failure category maps to false for data patterns", () => {
  const run = (p, values = ["a"]) => find("$.values[?match(@, $.p)]", { values, p });
  for (const [name, pattern] of [
    ["syntax", "("],
    ["pattern scalars", "[" + "a".repeat(4095) + "]"],
    ["group depth", "(".repeat(65) + "a" + ")".repeat(65)],
    ["quantifier digits", "a{0001024}"],
    ["repetitions", "a{1025}"],
    ["NFA states", "a".repeat(4096)],
  ])
    assert.deepStrictEqual(run(pattern), [], name);

  const lit = (p, values) => find("$[?match(@, " + JSON.stringify(p) + ")]", values);
  assert.deepStrictEqual(lit("a*", ["a".repeat(1_000_001)]), [], "subject scalars");
  assert.deepStrictEqual(lit("[" + "b".repeat(4093) + "]", ["a".repeat(1000)]), [], "transitions");
  assert.deepStrictEqual(run("("), [], "cached compile failure remains false");
});

test("errors not authenticated by Treffer are not swallowed", () => {
  const run = query('$[?match(@, "a")]');
  // Captured to restore in `finally`, never called — `unbound-method` reads the
  // saving of a prototype method as the scoping hazard of calling one.
  // oxlint-disable-next-line typescript/unbound-method
  const charCodeAt = String.prototype.charCodeAt;
  const spoof = Object.assign(Error("host failed"), { code: "TREFFER_SYNTAX" });
  try {
    String.prototype.charCodeAt = function (...args) {
      // Targeted: only the treffer-compiled pattern trips, so padvinder's own
      // parsing (which also reads char codes) is not the frame that throws.
      if (this == "a" || this == "zq") throw spoof;
      return charCodeAt.apply(this, args);
    };
    assert.throws(
      () => run(["a"]),
      (e) => e === spoof,
    );
    assert.throws(
      () => query('$[?match(@, "zq")]'),
      (e) => e === spoof,
      "the compile-time literal check rethrows unauthenticated errors too",
    );
  } finally {
    String.prototype.charCodeAt = charCodeAt;
  }
});

test("chained filters across segments", () => {
  const data = {
    groups: [
      {
        size: 2,
        items: [
          { n: "Sword", p: 5 },
          { n: "Moby", p: 50 },
        ],
      },
      { size: 1, items: [{ n: "Saying", p: 1 }] },
    ],
  };
  assert.deepStrictEqual(
    find("$.groups[?@.size > 1].items[?@.p < 10].n", data),
    ["Sword"],
    "one filter feeds the next",
  );
});

test("filters can reference the root as $", () => {
  assert.deepStrictEqual(find("$.store.book[?(@.price > $.store.bicycle.price)].title", data), [
    "The Lord of the Rings",
  ]);
});

test("@ inside filter strings survives", () => {
  const users = { list: [{ email: "a@b.c" }, { email: "x@y.z" }] };
  assert.deepStrictEqual(find('$.list[?(@.email == "a@b.c")].email', users), ["a@b.c"]);
});

test("custom functions in filters", () => {
  assert.deepStrictEqual(
    find("$.store.book[?(cheap(@))].title", data, { cheap: (b) => b.price < 9 }),
    ["Sayings of the Century", "Moby Dick"],
  );
});

test("compile once, run many", () => {
  const q = query("$..book[?(@.price < 10)].title");
  assert.deepStrictEqual(q(data), ["Sayings of the Century", "Moby Dick"]);
  assert.deepStrictEqual(q({ store: { book: [{ title: "x", price: 1 }] } }), ["x"]);
  assert.deepStrictEqual(q({}), []);
});

test("compiled queries expose frozen dependency topology", () => {
  const q = query('$..book[*][0,0,"title"][1:5:2][?@.price && $.store]');
  assert.deepStrictEqual(q.paths, [
    [
      "$",
      ["descendant", ["name", "book"]],
      ["wildcard"],
      ["union", ["index", 0], ["index", 0], ["name", "title"]],
      ["slice", 1, 5, 2],
      ["filter"],
    ],
    ["@", ["name", "price"]],
    ["$", ["name", "store"]],
  ]);
  assert.deepStrictEqual(q.functions, []);
  assert.ok(
    Object.isFrozen(q.paths) && Object.isFrozen(q.paths[0]) && Object.isFrozen(q.paths[0][1]),
  );
  assert.throws(() => q.paths[0][1].push("x"), TypeError, "nested tuples are immutable");
});

test("query metadata normalizes, deduplicates, orders, and isolates", () => {
  const q = query('$[?cheap(@.a) && @["a"] && count(@[:]) > 0 && cheap($.root)]', {
    cheap: Boolean,
  });
  assert.deepStrictEqual(q.paths, [
    ["$", ["filter"]],
    ["@", ["name", "a"]],
    ["@", ["slice", null, null, 1]],
    ["$", ["name", "root"]],
  ]);
  assert.deepStrictEqual(
    q.functions,
    ["cheap"],
    "built-ins are excluded and extensions deduplicate",
  );
  assert.ok(Object.isFrozen(q.functions));

  const a = query("$.a");
  const b = query('$["b"]');
  assert.deepStrictEqual(a.paths, [["$", ["name", "a"]]]);
  assert.deepStrictEqual(b.paths, [["$", ["name", "b"]]]);
  assert.notStrictEqual(a.paths, b.paths, "compiled metadata is isolated");
  assert.deepStrictEqual(query("$[-0]").paths, [["$", ["index", 0]]]);
});

test("introspection does not change execution or traversal budgets", () => {
  const q = query("$.rows[?@.ok].value", {}, { maxResults: 1 });
  assert.deepStrictEqual(q({ rows: [{ ok: true, value: 1 }] }), [1]);
  assert.deepStrictEqual(q.paths, [
    ["$", ["name", "rows"], ["filter"], ["name", "value"]],
    ["@", ["name", "ok"]],
  ]);
  assert.throws(
    () =>
      q({
        rows: [
          { ok: true, value: 1 },
          { ok: true, value: 2 },
        ],
      }),
    RangeError,
  );
});

const budgetShape = (e, name, limit) =>
  e.code === "PADVINDER_" + name.replace(/([A-Z])/g, "_$1").toUpperCase() &&
  e.limit === limit &&
  e.actual === limit + 1;
const budgetError = (name, limit) => (e) =>
  e instanceof RangeError && isDiagnostic(e) && budgetShape(e, name, limit);

test("opt-in traversal budgets have exact boundaries", () => {
  const check = (name, limit, run) => assert.throws(run, budgetError(name, limit));

  assert.deepStrictEqual(find("$.a.b", { a: { b: 1 } }, {}, { maxNodes: 3 }), [1]);
  check("maxNodes", 2, () => find("$.a.b", { a: { b: 1 } }, {}, { maxNodes: 2 }));
  assert.deepStrictEqual(find("$.a", { a: 1 }, {}, { maxDepth: 1 }), [1]);
  check("maxDepth", 0, () => find("$.a", { a: 1 }, {}, { maxDepth: 0 }));
  assert.deepStrictEqual(find("$[*]", [1, 2], {}, { maxResults: 2 }), [1, 2]);
  check("maxResults", 1, () => find("$[*]", [1, 2], {}, { maxResults: 1 }));
  check("maxNodes", 0, () => find("$", 1, {}, { maxNodes: 0 }));
  check("maxResults", 0, () => find("$", 1, {}, { maxResults: 0 }));
  assert.deepStrictEqual(find("$[*]", [], {}, { maxResults: 0 }), []);
});

test("depth is budgeted by default: deep data throws typed, not a stack overflow", () => {
  let deep = { v: 0 };
  for (let i = 0; i < 5000; i++) deep = { c: deep };
  assert.throws(
    () => find("$..*", deep),
    budgetError("maxDepth", 500),
    "no options at all still caps depth at 500",
  );
  assert.deepStrictEqual(find("$.a.b", { a: { b: 1 } }), [1], "shallow queries are unaffected");
  assert.throws(
    () => find("$..*", deep, {}, { maxNodes: 1e6 }),
    budgetError("maxDepth", 500),
    "other explicit budgets keep the depth default",
  );
});

test("an explicit Infinity opts a budget out", () => {
  let deep = { v: 0 };
  for (let i = 0; i < 600; i++) deep = { c: deep };
  assert.strictEqual(
    find("$..v", deep, {}, { maxDepth: Infinity }).length,
    1,
    "unbounded depth is a deliberate spelling, past the 500 default",
  );
  assert.deepStrictEqual(
    find("$[*]", [1, 2], {}, { maxResults: Infinity, maxNodes: Infinity }),
    [1, 2],
    "Infinity is a valid spelling for every budget",
  );
});

test("a compiled query knows whether it is singular", () => {
  assert.strictEqual(query("$").singular, true, "the root alone selects one node");
  assert.strictEqual(query("$.a.b").singular, true, "name segments stay singular");
  assert.strictEqual(query("$.a[0]").singular, true, "an index selector is singular");
  assert.strictEqual(query("$['a']").singular, true, "a quoted name is singular");
  assert.strictEqual(query("$[*]").singular, false, "a wildcard is not");
  assert.strictEqual(query("$..a").singular, false, "descendants are not");
  assert.strictEqual(query("$.a[1:3]").singular, false, "slices are not");
  assert.strictEqual(query("$.rows[?@.on]").singular, false, "filters are not");
});

test("filter subqueries share node budgets and reset depth", () => {
  const input = { rows: [{ a: { b: 1 } }, { a: { b: 2 } }] };
  assert.deepStrictEqual(
    find("$.rows[?@.a.b == 1]", input, {}, { maxDepth: 2 }),
    [input.rows[0]],
    "embedded @ starts at depth zero",
  );
  assert.throws(
    () => find("$.rows[?@.a.b]", input, {}, { maxNodes: 6 }),
    (e) => e instanceof RangeError && e.code === "PADVINDER_MAX_NODES",
    "embedded work consumes the top-level counter",
  );
});

test("cycles, shared nodes, early abort, and runner reuse stay bounded", () => {
  const cyclic = { name: "root" };
  cyclic.self = cyclic;
  assert.deepStrictEqual(find("$..name", cyclic, {}, { maxNodes: 4 }), ["root"]);

  const shared = { v: 1 };
  assert.deepStrictEqual(find("$..v", { a: shared, b: shared }, {}, { maxResults: 2 }), [1, 1]);

  let read = false;
  const guarded = { first: 1 };
  Object.defineProperty(guarded, "later", {
    enumerable: true,
    get() {
      read = true;
      return 2;
    },
  });
  assert.throws(() => find("$.*", guarded, {}, { maxNodes: 2 }), RangeError);
  assert.strictEqual(read, false, "the budget aborts before later data is read");

  const run = query("$..v", {}, { maxNodes: 3 });
  assert.throws(() => run({ a: { v: 1 }, b: { v: 2 } }), RangeError);
  assert.deepStrictEqual(run({ v: 3 }), [3], "a failed call does not poison the next counter");
});

test("recursive descent preserves preorder and eager budget accounting", () => {
  const sparse = [];
  sparse.length = 3;
  sparse[1] = { value: "array" };
  const shared = { value: "shared" };
  const input = { first: { value: "object", sparse }, left: shared, right: shared };
  assert.deepStrictEqual(find("$..value", input), ["object", "array", "shared", "shared"]);

  const reads = [];
  const guarded = {};
  Object.defineProperties(guarded, {
    first: {
      enumerable: true,
      get() {
        reads.push("first");
        return { value: 1 };
      },
    },
    second: {
      enumerable: true,
      get() {
        reads.push("second");
        return { value: 2 };
      },
    },
  });
  assert.throws(
    () => find("$..value", guarded, {}, { maxNodes: 2 }),
    (e) =>
      e instanceof RangeError &&
      e.code === "PADVINDER_MAX_NODES" &&
      e.limit === 2 &&
      e.actual === 3,
  );
  assert.deepStrictEqual(reads, ["first"], "budget fails before the next sibling getter");
});

test("recursive descent is stack-safe on deep chains", () => {
  const root = {},
    leaf = { value: "deep" };
  let node = root;
  for (let j = 0; j < 20_000; j++) node = node.next = j === 19_999 ? leaf : {};
  // Opting out of the default depth budget is exactly what this pin needs:
  // the descent itself must be iterative, not saved by the budget.
  assert.deepStrictEqual(find("$..value", root, {}, { maxDepth: Infinity }), ["deep"]);
});
