import { isDiagnostic, query } from "../lib/index.js";

// padvinder's only expected error is a compile-time SyntaxError (malformed path
// or filter). A compiled query never throws at run time and always returns an
// array of matches — so a runtime throw, or a non-array result, is a finding.
const isCompileErr = (e) => e instanceof SyntaxError && isDiagnostic(e);

export function compileOnly(path, funcs) {
  try {
    query(path, funcs);
  } catch (e) {
    if (!isCompileErr(e)) throw e;
  }
}

export function findSafe(path, data, funcs) {
  let run;
  try {
    run = query(path, funcs);
  } catch (e) {
    if (!isCompileErr(e)) throw e;
    return undefined;
  }
  const out = run(data);
  if (!Array.isArray(out)) throw new Error("query did not return an array");
  return out;
}

// Cycle-aware structural snapshot. Captures own properties (incl. non-enumerable
// and enumerability), prototype identity, array holes (absent own indexes), and
// object identity via a shared id map — so any mutation, reprototyping, or
// re-ordering is detectable even on cyclic graphs. Accessors are noted, never
// invoked. Compare snap(x) before and after an operation.
export function snap(v, seen = new Map(), box = { n: 0 }) {
  if (v === null) return "~";
  const t = typeof v;
  if (t !== "object" && t !== "function") {
    if (t === "number") return "n" + (Object.is(v, -0) ? "-0" : v);
    if (t === "string") return "s" + JSON.stringify(v);
    if (t === "bigint") return "B" + v;
    if (t === "symbol") return "y" + String(v);
    return t[0] + v;
  }
  if (seen.has(v)) return "#" + seen.get(v);
  const id = box.n++;
  seen.set(v, id);
  const p = Object.getPrototypeOf(v);
  const pt =
    p === null
      ? "NP"
      : p === Object.prototype
        ? "OP"
        : p === Array.prototype
          ? "AP"
          : p === Function.prototype
            ? "FP"
            : "P(" + snap(p, seen, box) + ")";
  let s = "@" + id + pt + "{";
  for (const k of Object.getOwnPropertyNames(v)) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    s += JSON.stringify(k) + (d.enumerable ? "+" : "-");
    s += d.get || d.set ? "A" : "=" + snap(d.value, seen, box);
    s += ";";
  }
  return s + "}";
}

// A fixed, ACYCLIC fixture with a unique primitive at every leaf, so a result
// can be traced to a genuine location: object results by identity, primitive
// results by value-set membership. (Cycles are exercised separately, in a
// bounded battery, because deepEq has no pair memoization.)
export const FIXTURE = {
  store: {
    book: [
      { id: 101, category: "reference", title: "Sayings", price: 8.95, tags: ["t-a", "t-b"] },
      { id: 102, category: "fiction", title: "Sword", price: 12.99, tags: ["t-c"] },
      { id: 103, category: "fiction", title: "Moby", price: 8.99, tags: [] },
    ],
    bicycle: { color: "red", price: 19.95, gears: 21 },
  },
  meta: { count: 300, active: true, note: "n-meta", missing: null },
  nums: [10, 11, 12, 13, 14],
  deep: { a: { b: { c: "c-leaf", d: 42 } } },
};

// Every object node (root included) and every primitive leaf, for the
// reachability oracle. Own keys only — matching the engine's access boundary.
export function collect(v, nodes = new Set(), leaves = new Set()) {
  if (v && typeof v === "object") {
    if (nodes.has(v)) return { nodes, leaves };
    nodes.add(v);
    for (const k of Object.keys(v)) collect(v[k], nodes, leaves);
  } else {
    leaves.add(v);
  }
  return { nodes, leaves };
}
