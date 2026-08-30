import assert from "node:assert/strict";
import test from "node:test";
import { isDiagnostic, query, relocate } from "../lib/index.js";

const caught = (run) => {
  try {
    run();
  } catch (e) {
    return e;
  }
  assert.fail("expected an error");
};

test("malformed paths", () => {
  assert.throws(() => query("store.book"), /Path must start with \$/);
  assert.throws(() => query(""), /Path must start with \$/);
  assert.throws(() => query("$.store["), /Missing \]/);
  assert.throws(() => query("$.store[?(@.a"), /Missing \]/);
  assert.throws(() => query("$[)]"), /Missing \]/, "a bare ) is not a bracket closer");
  assert.throws(() => query("$.store."), SyntaxError);
  assert.throws(() => query("$store"), SyntaxError, "name straight after $ needs a dot");
  assert.throws(() => query("$.store[!!]"), /Bad selector/);
  assert.throws(
    () => query('$["' + "\udc00" + '"]'),
    SyntaxError,
    "raw lone low surrogate in a name",
  );
});

test("invalid quoted-string escapes fail at compile time", () => {
  assert.throws(
    () => query(String.raw`$['a\"b']`),
    SyntaxError,
    "double-quote escape in single quotes",
  );
  assert.throws(
    () => query(String.raw`$["a\'b"]`),
    SyntaxError,
    "single-quote escape in double quotes",
  );
  assert.throws(() => query(String.raw`$['\uD800']`), SyntaxError, "lone high surrogate");
  assert.throws(() => query(String.raw`$["\uDC00"]`), SyntaxError, "lone low surrogate");
  assert.throws(
    () => query("$['\ud83d" + String.raw`\uDE00']`),
    SyntaxError,
    "raw high plus escaped low surrogate",
  );
  assert.throws(
    () => query(String.raw`$['\uD83D` + "\ude00']"),
    SyntaxError,
    "escaped high plus raw low surrogate",
  );
  assert.throws(() => query(String.raw`$['\u12']`), SyntaxError, "short Unicode escape");
  assert.throws(() => query("$['line\nbreak']"), SyntaxError, "raw control character");
  assert.throws(
    () => query(String.raw`$[?@ == 'a\"b']`),
    SyntaxError,
    "filter string uses the same decoder",
  );
});

test("bad filter expressions fail at compile time", () => {
  assert.throws(() => query("$.a[?(@.x >)]"), SyntaxError);
  assert.throws(() => query("$.a[?(nope(@))]"), /nope is not a function/);
  assert.throws(() => query("$.a[?()]"), SyntaxError);
  assert.throws(
    () => query("$.a[?constructor(@)]"),
    /constructor is not a function/,
    "inherited name is not a built-in function",
  );
  assert.throws(
    () => query('$[?length(match(@, "a"))]'),
    SyntaxError,
    "LogicalType cannot fill a ValueType argument",
  );
  assert.throws(() => query("$[?!@.a == 1]"), SyntaxError, "negation cannot wrap a comparison");
  assert.throws(() => query("$[?@.a == 1#]"), SyntaxError, "trailing junk after a filter");
  assert.doesNotThrow(
    () => query("$[?foo()]", { foo: () => true }),
    "zero-arg user functions are valid",
  );
});

test("invalid traversal options fail at compile time", () => {
  for (const options of [1, [], "x"]) assert.throws(() => query("$", {}, options), TypeError);
  for (const [name, value, type] of [
    ["maxNodes", "1", TypeError],
    ["maxDepth", -1, RangeError],
    ["maxResults", 1.5, RangeError],
    ["maxNodes", -Infinity, RangeError],
  ])
    assert.throws(() => query("$", {}, { [name]: value }), type);
  assert.throws(() => query("$", {}, { maxNode: 1 }), /Unknown option/);
  assert.deepStrictEqual(query("$", {}, null)(1), [1]);
});

const noBudgetFields = (e) =>
  !Object.hasOwn(e, "code") && !Object.hasOwn(e, "limit") && !Object.hasOwn(e, "actual");
const bareDiagnostic = (Type) => (e) => e instanceof Type && isDiagnostic(e) && noBudgetFields(e);

test("padvinder-created errors are authenticated", () => {
  // Option faults are about the call, not about a place in the query, so they
  // carry no code and no span; a syntax fault carries both.
  for (const [run, Type] of [
    [() => query("$", {}, 1), TypeError],
    [() => query("$", {}, { maxDepth: -1 }), RangeError],
  ])
    assert.throws(run, bareDiagnostic(Type));

  assert.throws(
    () => query("store.book"),
    (e) =>
      e instanceof SyntaxError &&
      isDiagnostic(e) &&
      e.code === "PADVINDER_SYNTAX" &&
      !Object.hasOwn(e, "limit"),
  );
});

test("diagnostic provenance cannot be copied", () => {
  for (const value of [null, undefined, 1, "PADVINDER_MAX_NODES", {}, SyntaxError("host")])
    assert.strictEqual(isDiagnostic(value), false);

  const spoof = Object.assign(RangeError("spoof"), {
    code: "PADVINDER_MAX_NODES",
    limit: 1,
    actual: 2,
  });
  assert.strictEqual(isDiagnostic(spoof), false);
});

test("diagnostic provenance is local to a module instance", async () => {
  const other = await import("../lib/index.js?instance=provenance");
  let first, second;
  try {
    query("bad");
  } catch (e) {
    first = e;
  }
  try {
    other.query("bad");
  } catch (e) {
    second = e;
  }

  assert.ok(isDiagnostic(first));
  assert.ok(other.isDiagnostic(second));
  assert.strictEqual(isDiagnostic(second), false);
  assert.strictEqual(other.isDiagnostic(first), false);
});

test("runtime diagnostic provenance is scoped to its runner", () => {
  const first = query("$[*]", {}, { maxResults: 0 });
  const second = query("$[*]", {}, { maxResults: 0 });
  const one = caught(() => first([1]));
  const two = caught(() => first([2]));

  assert.ok(one instanceof RangeError);
  assert.ok(isDiagnostic(one));
  assert.ok(first.isDiagnostic(one));
  assert.ok(first.isDiagnostic(two), "repeated calls keep the same runner origin");
  assert.strictEqual(second.isDiagnostic(one), false);
  assert.deepStrictEqual([one.code, one.limit, one.actual], ["PADVINDER_MAX_RESULTS", 0, 1]);

  const compileError = caught(() => query("bad"));
  assert.ok(isDiagnostic(compileError));
  assert.strictEqual(
    first.isDiagnostic(compileError),
    false,
    "compile errors have package provenance only",
  );
});

test("runtime provenance is local to a module instance", async () => {
  const other = await import("../lib/index.js?instance=runtime-provenance");
  const first = query("$[*]", {}, { maxResults: 0 });
  const second = other.query("$[*]", {}, { maxResults: 0 });
  const one = caught(() => first([1]));
  const two = caught(() => second([1]));

  assert.ok(first.isDiagnostic(one));
  assert.ok(second.isDiagnostic(two));
  assert.strictEqual(first.isDiagnostic(two), false);
  assert.strictEqual(second.isDiagnostic(one), false);
  assert.strictEqual(isDiagnostic(two), false);
  assert.strictEqual(other.isDiagnostic(one), false);
});

test("captured provenance operations resist prototype replacement", () => {
  // Captured to restore in `finally`, never called — `unbound-method` reads the
  // saving of a prototype method as the scoping hazard of calling one.
  // oxlint-disable-next-line typescript/unbound-method
  const set = WeakMap.prototype.set;
  // oxlint-disable-next-line typescript/unbound-method
  const get = WeakMap.prototype.get;
  // oxlint-disable-next-line typescript/unbound-method
  const has = WeakMap.prototype.has;
  const run = query("$[*]", {}, { maxResults: 0 });
  try {
    WeakMap.prototype.set = function () {
      return this;
    };
    WeakMap.prototype.get = () => ({});
    WeakMap.prototype.has = () => true;
    assert.strictEqual(
      isDiagnostic(Object.assign(SyntaxError("spoof"), { code: "PADVINDER_MAX_NODES" })),
      false,
    );
    assert.throws(
      () => query("bad"),
      (e) => e instanceof SyntaxError && isDiagnostic(e),
    );
    assert.throws(
      () => run([1]),
      (e) => e instanceof RangeError && isDiagnostic(e) && run.isDiagnostic(e),
    );
  } finally {
    WeakMap.prototype.set = set;
    WeakMap.prototype.get = get;
    WeakMap.prototype.has = has;
  }
});

test("authentic host errors do not inherit the outer runner origin", () => {
  const compileError = caught(() => query("bad"));
  const foreign = query("$[*]", {}, { maxResults: 0 });
  const runtimeError = caught(() => foreign([1]));
  const getterData = {};
  Object.defineProperty(getterData, "value", {
    enumerable: true,
    get() {
      throw runtimeError;
    },
  });
  const coercible = {
    [Symbol.toPrimitive]() {
      throw runtimeError;
    },
  };
  const cases = [
    [
      query("$[?boom(@)]", {
        boom() {
          throw compileError;
        },
      }),
      [1],
      compileError,
    ],
    [
      query("$[?boom(@)]", {
        boom() {
          return foreign([1]);
        },
      }),
      [1],
      null,
      foreign,
    ],
    [query("$.*"), getterData, runtimeError, foreign],
    [
      query("$[?coerce(@)]", { coerce: (x) => Boolean(String(x)) }),
      [coercible],
      runtimeError,
      foreign,
    ],
  ];

  for (const [run, data, expected, owner] of cases) {
    const e = caught(() => run(data));
    if (expected) assert.strictEqual(e, expected, "host error identity is preserved");
    assert.ok(isDiagnostic(e), "the package still authenticates the inner error");
    if (owner)
      assert.ok(owner.isDiagnostic(e), "the creating runner still authenticates the error");
    assert.strictEqual(run.isDiagnostic(e), false, "the outer runner rejects it");
  }
});

test("caller errors pass through unchanged", () => {
  const host = Object.assign(Error("host failed"), { code: "PADVINDER_MAX_NODES" });
  const path = {
    toString() {
      throw host;
    },
  };
  const data = {};
  Object.defineProperty(data, "value", {
    enumerable: true,
    get() {
      throw host;
    },
  });

  for (const run of [
    () => query(path),
    () => query("$.*")(data),
    () =>
      query("$[?fail(@)]", {
        fail() {
          throw host;
        },
      })([1]),
  ])
    assert.throws(run, (e) => e === host && !isDiagnostic(e));
});

const span = (path) => {
  const e = caught(() => query(path));
  assert.ok(e instanceof SyntaxError);
  assert.ok(isDiagnostic(e));
  assert.strictEqual(e.code, "PADVINDER_SYNTAX");
  return [e.start, e.end];
};

test("compile errors carry a code and a span in query coordinates", () => {
  assert.deepStrictEqual(span("store.book"), [0, 1], "the character that should have been $");
  assert.deepStrictEqual(span(""), [0, 0], "an empty query is an empty span");
  assert.deepStrictEqual(span("$.store["), [7, 8], "an unclosed bracket points at the bracket");
  assert.deepStrictEqual(span("$.store."), [8, 8], "a trailing dot ends the query early");
  assert.deepStrictEqual(span("$store"), [1, 2], "the character that needed a dot before it");
  assert.deepStrictEqual(span("$.store[!!]"), [8, 10], "a bad selector spans the selector");
  assert.deepStrictEqual(span("$.a[?(@.x >)]"), [11, 11], "a filter fault is in query coordinates");
  assert.deepStrictEqual(span("$.a[?(nope(@))]"), [6, 10], "an unknown function spans its name");
});

const offender = (path) => path.slice(...span(path));

test("spans stay in query coordinates however deep the fault is", () => {
  // The relative path inside a filter is parsed by the same path parser as the
  // query itself, on filter-local text; its faults still come back in query
  // coordinates.
  assert.strictEqual(offender("$.a[?(@.b[!!])]"), "!!", "a bad selector inside a filter");
  assert.strictEqual(offender("$.a[?(@.-)]"), "-", "a bad path character inside a filter");
  assert.strictEqual(offender("$.a[?(@['\\q'])]"), "\\q", "a bad escape inside a filter literal");
  // A nested filter is at an offset within the filter that contains it.
  assert.strictEqual(offender("$.a[?(@.b[?(nope(@))])]"), "nope", "a fault in a nested filter");
  // Parsing trims, but the caller's string is what the offsets index into.
  assert.strictEqual(offender("   $.store["), "[", "leading whitespace does not shift a span");
});

test("relocate returns an authenticated copy in the embedder's coordinates", () => {
  const original = caught(() => query("$.store["));
  const moved = relocate(original, { prefix: "data: ", offset: 6 });

  assert.ok(moved instanceof SyntaxError);
  assert.strictEqual(moved.message, "data: " + original.message);
  assert.strictEqual(moved.code, "PADVINDER_SYNTAX");
  assert.deepStrictEqual([moved.start, moved.end], [13, 14]);
  assert.ok(isDiagnostic(moved));
  assert.deepStrictEqual([original.start, original.end], [7, 8], "the original is left untouched");
});

test("relocate preserves the runner origin of a runtime diagnostic", () => {
  const run = query("$..a", {}, { maxNodes: 1 });
  const original = caught(() => run({ a: { a: 1 } }));

  const moved = relocate(original, { prefix: "data: " });
  assert.ok(run.isDiagnostic(moved), "still recognized by the runner that threw it");
  assert.strictEqual(moved.code, original.code);
  assert.strictEqual(moved.limit, original.limit);
  assert.ok(!Object.hasOwn(moved, "start"), "a budget diagnostic has no span to shift");
});

test("relocate defaults to no prefix and no shift", () => {
  const original = caught(() => query("$.store["));
  const moved = relocate(original);

  assert.strictEqual(moved.message, original.message);
  assert.deepStrictEqual([moved.start, moved.end], [original.start, original.end]);
  assert.ok(isDiagnostic(moved));
});

test("relocate refuses anything that is not a padvinder diagnostic", () => {
  const spoof = Object.assign(SyntaxError("spoof"), {
    code: "PADVINDER_SYNTAX",
    start: 0,
    end: 1,
  });
  for (const value of [null, undefined, 1, "PADVINDER_SYNTAX", {}, SyntaxError("host"), spoof])
    assert.throws(() => relocate(value), TypeError);
});

test("relocate does not mint a diagnostic through a replaced constructor", () => {
  const d = caught(() => query("$.store["));
  const real = SyntaxError.prototype.constructor;
  try {
    SyntaxError.prototype.constructor = function () {
      return { pwned: true };
    };
    const moved = relocate(d, { prefix: "x: " });
    assert.ok(moved instanceof SyntaxError, "the class comes from a captured table");
    assert.ok(!Object.hasOwn(moved, "pwned"));
    assert.ok(isDiagnostic(moved));
  } finally {
    SyntaxError.prototype.constructor = real;
  }
});

test("relocate degrades to a plain Error when the original's prototype was replaced", () => {
  const d = caught(() => query("$.store["));
  Object.setPrototypeOf(d, Object.create(null));

  const moved = relocate(d, { prefix: "x: " });
  assert.ok(moved instanceof Error, "an unrecognized class falls back to Error");
  assert.ok(isDiagnostic(moved), "and is still authenticated");
});

test("relocate keeps an option fault a TypeError", () => {
  const d = caught(() => query("$", {}, 1));
  const moved = relocate(d, { prefix: "data: " });

  assert.ok(moved instanceof TypeError);
  assert.ok(isDiagnostic(moved));
  assert.ok(!Object.hasOwn(moved, "start"), "an option fault is not a place in the query");
});

test("string-literal faults point at the offending escape or character", () => {
  assert.strictEqual(offender("$['a\\qb']"), "\\q", "an unknown escape spans backslash and char");
  assert.strictEqual(offender("$['a\\u12Gb']"), "\\u12Gb", "a bad hex quad spans the whole escape");
  assert.strictEqual(
    offender("$['\\u12']"),
    "\\u12",
    "a truncated escape stops at the closing quote",
  );
  assert.strictEqual(
    offender("$['a\\udc00b']"),
    "\\udc00",
    "a lone low surrogate escape spans itself",
  );
  assert.strictEqual(
    offender("$['a\\ud800bc']"),
    "\\ud800",
    "a high surrogate needing a pair points at itself",
  );
  assert.strictEqual(offender("$['a\ud800b']"), "\ud800", "a raw lone surrogate points at itself");
  assert.strictEqual(offender('$["a\u0001b"]'), "\u0001", "a control character points at itself");
});

test("relocate names this package when it refuses, not its dependency", () => {
  // The message is documented here, and the guard has to stay here to keep it:
  // waarmerk refuses in its own name, which is a package the caller never chose.
  assert.throws(
    () => relocate(SyntaxError("from somewhere else")),
    (e) => e instanceof TypeError && e.message === "Not a diagnostic from padvinder",
  );
});
