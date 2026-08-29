import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { find, isDiagnostic } from "../lib/index.js";

const notOk = (value, message) => assert.ok(!value, message);

test("blocked keys never match", () => {
  assert.deepStrictEqual(find("$.constructor", {}), []);
  assert.deepStrictEqual(find("$.a.__proto__", { a: {} }), []);
  assert.deepStrictEqual(find("$['__proto__']", {}), []);
  assert.deepStrictEqual(find("$..constructor", { a: { b: 1 } }), []);
  assert.deepStrictEqual(
    find("$.*", { __proto__: null, a: 1, constructor: 2 }),
    [1],
    "wildcard skips blocked own keys",
  );
});

test("blocked keys inside filters match nothing", () => {
  assert.deepStrictEqual(
    find("$.list[?@.constructor]", { list: [{}] }),
    [],
    "existence test, no match",
  );
  assert.deepStrictEqual(find('$.list[?@["__proto__"]]', { list: [{}] }), []);
  assert.deepStrictEqual(
    find("$.list[?@.constructor == 1]", { list: [{}] }),
    [],
    "comparison never reaches the prototype",
  );
});

test("inherited properties never match", () => {
  const proto = { inherited: "nope" };
  const obj = Object.assign(Object.create(proto), { own: "yes" });
  assert.deepStrictEqual(find("$.a.inherited", { a: obj }), []);
  assert.deepStrictEqual(find("$.a.own", { a: obj }), ["yes"]);
});

test("getters cannot expose inherited properties during traversal", () => {
  const proto = { later: "inherited" };
  const obj = Object.create(proto);
  Object.defineProperty(obj, "first", {
    enumerable: true,
    get() {
      delete obj.later;
      return "own";
    },
  });
  obj.later = "deleted";
  assert.deepStrictEqual(find("$.a[*]", { a: obj }), ["own"]);
});

test("inherited array indexes never match", () => {
  // A real array (Array.isArray stays true) with a hole at index 0 whose value
  // would resolve through a custom prototype — the index, wildcard, descendant,
  // and slice paths must all read own elements only.
  const proto = Object.create(Array.prototype);
  proto[0] = "inherited";
  const arr = [];
  arr.length = 2;
  arr[1] = "own";
  Object.setPrototypeOf(arr, proto);
  assert.deepStrictEqual(find("$.arr[0]", { arr }), [], "index selector skips the hole");
  assert.deepStrictEqual(find("$.arr[*]", { arr }), ["own"], "wildcard skips the hole");
  assert.deepStrictEqual(find("$.arr..*", { arr }), ["own"], "descendant skips the hole");
  assert.deepStrictEqual(find("$.arr[0:2]", { arr }), ["own"], "slice skips the hole");
  assert.deepStrictEqual(find("$.arr[1]", { arr }), ["own"], "own index still matches");
});

test("recursive descent survives cyclic data", () => {
  const node = { name: "x" };
  node.self = node;
  assert.deepStrictEqual(find("$..name", { node }), ["x"], "cycle visited once, no hang");

  const shared = { v: 1 };
  assert.deepStrictEqual(
    find("$..v", { p: shared, q: shared }),
    [1, 1],
    "diamond refs still match per location",
  );
});

test("deep equality comparisons stay off the native call stack", () => {
  let a = 0,
    b = 0;
  for (let i = 0; i < 100_000; i++) {
    a = [a];
    b = [b];
  }
  assert.deepStrictEqual(
    find("$.r[?@.a == @.b].k", { r: [{ a, b, k: "eq" }] }),
    ["eq"],
    "a 100k-deep equal pair compares without overflowing",
  );
  b[0] = "different";
  assert.deepStrictEqual(
    find("$.r[?@.a == @.b]", { r: [{ a, b }] }),
    [],
    "a deep unequal pair still compares false",
  );
});

test("cyclic equality comparisons terminate with a typed diagnostic", () => {
  const a = { v: 1 },
    b = { v: 1 };
  a.self = a;
  b.self = b;
  let caught;
  try {
    find("$.r[?@.a == @.b]", { r: [{ a, b }] });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof RangeError, "a RangeError, not a hang");
  assert.strictEqual(caught.code, "PADVINDER_MAX_COMPARISONS");
  assert.ok(isDiagnostic(caught), "authenticated as a padvinder diagnostic");
});

test("queries never modify the data", () => {
  const data = { store: { book: [{ price: 5 }] } };
  const snapshot = JSON.stringify(data);
  find("$..book[?(@.price > 1)].price", data);
  assert.strictEqual(JSON.stringify(data), snapshot);
});

test("source contains no string-to-code constructs", () => {
  const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  notOk(/\beval\b|\bFunction\s*\(|new\s+Function/.test(src));
});

test("I-Regexp matching has bounded worst-case work", () => {
  const n = 30_000;
  const text = "a".repeat(n) + "!";
  const t0 = Date.now();

  // Data-sourced: a literal catastrophic pattern is now a loud compile fault
  // (query.test.js pins that); the bounded-work property under test is the
  // soft row-time path.
  assert.deepStrictEqual(
    find("$.texts[?search(@, $.p)]", { texts: [text], p: "(a+)+$" }),
    [],
    "nested repetition",
  );
  assert.deepStrictEqual(
    find('$[?match(@, "(a*)*")]', ["a".repeat(n)]),
    ["a".repeat(n)],
    "nullable cycle",
  );
  assert.deepStrictEqual(find('$[?search(@, "(a|aa)+$")]', [text]), [], "ambiguous alternation");
  assert.deepStrictEqual(
    find("$.values[?match(@, $.p)]", { values: ["a"], p: "a{1000000}" }),
    [],
    "huge range rejected",
  );
  assert.deepStrictEqual(
    find("$[?search(@, " + JSON.stringify("[" + "b".repeat(4093) + "]") + ")]", [text]),
    [],
    "class work cap",
  );
  assert.deepStrictEqual(
    find("$.values[?match(@, $.p)]", {
      values: Array(5000).fill("a"),
      p: "a{1024}a{1024}a{1024}a{1024}",
    }),
    [],
    "invalid pattern cache",
  );
  assert.deepStrictEqual(
    find('$[?search(@, "")]', ["a".repeat(1_000_001)]),
    [],
    "subject scalar cap",
  );
  assert.deepStrictEqual(
    find("$.values[?match(@, $.regex)]", {
      regex: "a".repeat(1_000_000),
      values: Array(5000).fill("a"),
    }),
    [],
    "oversized dynamic pattern is not retained",
  );

  assert.ok(Date.now() - t0 < 1500, "completes within the work budget");
});
