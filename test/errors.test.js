import assert from "node:assert/strict";
import test from "node:test";
import { isDiagnostic, query } from "../lib/index.js";

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
  assert.throws(() => query("$.store."), SyntaxError);
  assert.throws(() => query("$store"), SyntaxError, "name straight after $ needs a dot");
  assert.throws(() => query("$.store[!!]"), /Bad selector/);
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
});

test("invalid traversal options fail at compile time", () => {
  for (const options of [1, [], "x"]) assert.throws(() => query("$", {}, options), TypeError);
  for (const [name, value, type] of [
    ["maxNodes", "1", TypeError],
    ["maxDepth", -1, RangeError],
    ["maxResults", 1.5, RangeError],
    ["maxNodes", Infinity, RangeError],
  ])
    assert.throws(() => query("$", {}, { [name]: value }), type);
  assert.throws(() => query("$", {}, { maxNode: 1 }), /Unknown option/);
  assert.deepStrictEqual(query("$", {}, null)(1), [1]);
});

const noBudgetFields = (e) =>
  !Object.hasOwn(e, "code") && !Object.hasOwn(e, "limit") && !Object.hasOwn(e, "actual");
const bareDiagnostic = (Type) => (e) => e instanceof Type && isDiagnostic(e) && noBudgetFields(e);

test("padvinder-created errors are authenticated", () => {
  for (const [run, Type] of [
    [() => query("store.book"), SyntaxError],
    [() => query("$", {}, 1), TypeError],
    [() => query("$", {}, { maxDepth: -1 }), RangeError],
  ])
    assert.throws(run, bareDiagnostic(Type));
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
