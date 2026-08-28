/**
 * Tiny, CSP-safe RFC 9535 JSONPath engine.
 * Paths and filters compile to a composition of closures; query text is
 * never turned into JavaScript, so strict CSP is satisfied.
 */

import { compile as compileRE, isDiagnostic as isREDiagnostic } from "treffer";

/**
 * The public types are declared once, in the hand-written `index.d.ts` beside
 * this file, and pulled in here — so a signature that drifts from what ships
 * fails to compile.
 *
 * @import { PadvinderDiagnostic, PadvinderErrorCode, QueryOptions, QueryRunner } from './index.js'
 */

/**
 * A located value: the value itself plus the depth it was found at. This is
 * the currency every traversal step passes around.
 *
 * @internal
 * @typedef {{ value: any, depth: number }} Loc
 */

/**
 * Per-execution budgets and counters, positional so the hot path indexes
 * rather than looks up: `[maxNodes, maxDepth, maxResults, nodesSeen, root]`,
 * or nullish when the caller passed no budgets.
 *
 * Deliberately `any`: it is a heterogeneous array read by computed numeric
 * index on the hottest path in the engine, and a precise tuple type buys a
 * cast at every access rather than any real safety.
 *
 * @internal
 * @typedef {any} Ctx
 */

/**
 * One compiled selector: `run` executes it against a node, `topology` is the
 * dependency-topology tuple published through `runner.paths`.
 *
 * @internal
 * @typedef {{ r: (n: Loc, root: any, ctx: Ctx) => Loc[], t: any[] }} Sel
 */

/**
 * One compiled segment: `d` marks a descendant (`..`) segment, `s` marks a
 * singular one per RFC 9535.
 *
 * @internal
 * @typedef {{ d: boolean, s: boolean, f: (ns: Loc[], root: any, ctx: Ctx) => Loc[] }} Seg
 */

/**
 * A compiled filter test, evaluated per candidate node.
 *
 * @internal
 * @typedef {(v: any, root: any, ctx: Ctx) => any} Test
 */

/**
 * A compiled filter expression: given the current node value, the root, and
 * the context, produce a value — or the `NOTHING` sentinel for a missing one.
 *
 * @internal
 * @typedef {(n: any, r: any, ctx: Ctx) => any} Arg
 */

/**
 * A parsed filter primary. Exactly one shape is populated: `q` for a query,
 * `v` for a value producer (`u` marks a registered function, whose result may
 * be truthiness-tested), or `l` for a logical function.
 *
 * @internal
 * @typedef {{ q?: { s: boolean, f: (n: any, r: any, ctx: Ctx) => Loc[] }, v?: Arg, u?: boolean, l?: Arg }} Prim
 */

/** @param {any} k */
const BLOCK = (k) => k === "__proto__" || k === "constructor" || k === "prototype";
const LIMITS = ["maxNodes", "maxDepth", "maxResults"];
// Positionally parallel to LIMITS. Kept as literals so tsc checks them against
// PadvinderErrorCode at the `cap()` call site.
/** @type {PadvinderErrorCode[]} */
const CODES = ["PADVINDER_MAX_NODES", "PADVINDER_MAX_DEPTH", "PADVINDER_MAX_RESULTS"];

/**
 * Null-prototype tables: arbitrary text is used as a key, so a normal object
 * would turn `constructor` into Object's constructor.
 *
 * @template T
 * @param {T} entries
 * @returns {T}
 */
let table = (entries) => Object.assign(Object.create(null), entries);

let diags = new WeakMap(),
  mark = diags.set.bind(diags),
  origin = diags.get.bind(diags);
/**
 * Test whether an error was created by this padvinder module instance.
 *
 * The bound `WeakMap.has` is a `(key: WeakKey) => boolean`, which cannot be
 * assigned to a type-predicate signature; the cast publishes the narrowing
 * consumers rely on.
 *
 * @type {(error: unknown) => error is PadvinderDiagnostic}
 */
export let isDiagnostic = /** @type {any} */ (diags.has.bind(diags));

/**
 * Intrinsics captured at module load, exactly as `mark`/`origin` are: a copy is
 * built from a fixed table of error classes rather than through the original's
 * `constructor`, so replacing a prototype's `constructor` cannot make
 * `relocate` mint an authenticated value that is not an Error.
 */
const DESCS = Object.getOwnPropertyDescriptors,
  DEFINE = Object.defineProperties,
  PROTO = Object.getPrototypeOf,
  SYNTAX = SyntaxError.prototype,
  TYPE = TypeError.prototype,
  RANGE = RangeError.prototype;
/** @type {(p: any) => (msg: string) => Error} */
const kindOf = (p) =>
  p === SYNTAX ? SyntaxError : p === TYPE ? TypeError : p === RANGE ? RangeError : Error;
/**
 * Copy a diagnostic into an embedder's coordinates.
 *
 * Relocation lives here, beside the authentication it has to satisfy: the copy
 * is registered in the same WeakMap as the original, so it passes both
 * `isDiagnostic` and the `isDiagnostic` of the runner that threw it. The
 * original is never mutated, and every own field comes across by descriptor,
 * so a field added here is never a field an embedder forgets. A budget
 * diagnostic has no span to shift and keeps none.
 *
 * @param {unknown} diag A diagnostic from this module instance.
 * @param {{ prefix?: string, offset?: number }} [opts] `prefix` is prepended to
 *   the message verbatim; `offset` shifts `start` and `end` when there is a span.
 * @returns {PadvinderDiagnostic} The relocated copy.
 * @throws {TypeError} When `diag` is not a diagnostic from this instance.
 */
export let relocate = (diag, { prefix = "", offset = 0 } = {}) => {
  if (!isDiagnostic(diag)) throw TypeError("Not a padvinder diagnostic");
  let d = /** @type {any} */ (diag),
    props = DESCS(d),
    copy = kindOf(PROTO(d))(prefix + d.message);
  delete props.message;
  delete props.stack;
  if (props.start) {
    props.start.value += offset;
    props.end.value += offset;
  }
  DEFINE(copy, props);
  return (mark(copy, origin(d)), /** @type {PadvinderDiagnostic} */ (copy));
};
/**
 * @param {(msg: string) => Error} Type
 * @param {string} msg
 * @param {any} [own]
 * @returns {Error}
 */
// oxlint-disable-next-line no-unused-expressions
let fault = (Type, msg, own, e = Type(msg)) => (mark(e, own), e);
/**
 * Throw a compile-time diagnostic. `start` and `end` are offsets into whatever
 * text the caller is parsing — the query, or a filter body, or a relative path
 * inside one — and `base` carries them the rest of the way to the coordinates
 * of the string the caller of `query()` passed in. Adding it here rather than
 * at the call sites is what keeps a nested parser from having to know how deep
 * it is.
 *
 * @type {(m: string, start: number, end: number) => never}
 */
const err = (m, start, end) => {
  const e = /** @type {any} */ (fault(SyntaxError, m));
  e.code = "PADVINDER_SYNTAX";
  e.start = base + start;
  e.end = base + end;
  throw e;
};

/**
 * Shared filter-parser state. Parsing is synchronous, including nested
 * filters, which save and restore these around the inner compile.
 *
 * @type {string}
 */
let source = "";
/** @type {number} */
let k = 0;
/**
 * Offset of `source` within the query string, so a filter fault reports where
 * it is in the query rather than where it is in the filter.
 *
 * @type {number}
 */
let base = 0;
/** @type {Record<string, Function>} */
let fns = {};
/** @type {any} */
let meta;

/**
 * `const`, not `let`: TypeScript only propagates a `never` return through
 * control-flow analysis when the callee binding cannot be reassigned.
 *
 * @type {() => never}
 */
const fail = () => err("Bad filter: " + source, k, k);
/**
 * Throw for a bad string literal, spanning `[from, to)` in the coordinates of
 * whatever text the literal's caller is parsing — the unq chain threads that
 * offset down, so the span is the offending escape or character rather than
 * the whole literal.
 *
 * @type {(from: number, to: number) => never}
 */
const bad = (from, to) => err("Invalid string literal", from, to);

// A one-entry cache avoids recompiling a document-supplied pattern per node
// without retaining an attacker-controlled set of patterns.
/** @type {string | undefined} */
let reLast;
/** @type {any} */
let reNfa;
/** @param {string} p */
let reFresh = (p) => {
  if (p === reLast) return;
  reLast = p;
  reNfa = null;
  reNfa = compileRE(p, { anchors: true });
};
/**
 * @param {string} s
 * @param {boolean} [full]
 * @returns {boolean}
 */
let reRun = (s, full) => (reNfa.code ? false : full ? reNfa.match(s) : reNfa.search(s));
/**
 * @param {string} s
 * @param {string} p
 * @param {boolean} [full]
 * @returns {boolean}
 */
let reTry = (s, p, full) => {
  try {
    reFresh(p);
    return reRun(s, full);
  } catch (e) {
    if (!isREDiagnostic(e)) throw e;
    // oxlint-disable-next-line no-unused-expressions
    reNfa || (reNfa = e);
    return false;
  }
};
/**
 * @param {any} s
 * @param {any} p
 * @param {boolean} [full]
 * @returns {boolean}
 */
let reTest = (s, p, full) =>
  typeof s === "string" && typeof p === "string" && p.length <= 8192 && reTry(s, p, full);

// Own child values of a node (guarded). Arrays enumerate own indexes only, so
// a hole never reads an inherited value off the prototype chain.
// One builder for every exhausted-budget diagnostic: camelCase budget name and
// its code in, typed RangeError out. The code is a literal from CODES rather
// than derived from `name`, so tsc checks it against the published union — a
// derived string would satisfy `string` and drift silently.
/**
 * @param {string} name
 * @param {PadvinderErrorCode} code
 * @param {number} max
 * @param {number} actual
 * @param {any} [own] The value the budget was exhausted on, when there is one.
 * @returns {never}
 */
const cap = (name, code, max, actual, own) => {
  const e = /** @type {Error & { code: PadvinderErrorCode, limit: number, actual: number }} */ (
    fault(RangeError, name + " limit of " + max + " exceeded", own)
  );
  e.code = code;
  e.limit = max;
  e.actual = actual;
  throw e;
};
/**
 * @param {Ctx} ctx
 * @param {number} key
 * @param {number} actual
 */
let limit = (ctx, key, actual) => {
  const max = ctx?.[key];
  if (max !== undefined && actual > max) cap(LIMITS[key], CODES[key], max, actual, ctx[4]);
};

/**
 * @param {any} value
 * @param {number} depth
 * @param {Ctx} ctx
 * @returns {Loc}
 */
let loc = (value, depth, ctx) => {
  limit(ctx, 1, depth);
  if (ctx) limit(ctx, 0, ++ctx[3]);
  return { value, depth };
};

/**
 * @param {any} obj
 * @param {any} key
 * @param {number} depth
 * @param {Ctx} ctx
 * @returns {Loc | null}
 */
let edge = (obj, key, depth, ctx) => {
  if (!Object.hasOwn(obj, key)) return null;
  limit(ctx, 1, depth);
  if (ctx) limit(ctx, 0, ctx[3] + 1);
  return loc(obj[key], depth, ctx);
};

// Guarded edge into `out` — the one collector every traversal loop shares.
/**
 * @param {Loc[]} out
 * @param {any} obj
 * @param {any} key
 * @param {number} depth
 * @param {Ctx} ctx
 */
let put = (out, obj, key, depth, ctx, x = edge(obj, key, depth, ctx)) => x && out.push(x);

/** @param {any} obj @returns {string[]} */
let ownKeys = (obj) => Object.keys(obj).filter((key) => !BLOCK(key));
/**
 * @param {Loc} node
 * @param {Ctx} ctx
 * @returns {Loc[]}
 */
let kids = (
  node,
  ctx,
  value = node.value,
  depth = node.depth + 1,
  out = /** @type {Loc[]} */ ([]),
) => {
  if (+!value | +(typeof value !== "object")) return out;
  for (const key of Array.isArray(value) ? value.keys() : ownKeys(value))
    put(out, value, key, depth, ctx);
  return out;
};

/**
 * @param {Loc} node
 * @param {Set<any>} seen
 * @param {any[]} stack
 */
let enterObject = (node, seen, stack, value = node.value) => {
  if (value && typeof value === "object") {
    if (seen.has(value)) return false;
    seen.add(value);
    stack.push(value);
  }
  return true;
};
/**
 * @param {Loc} node
 * @param {Ctx} ctx
 * @param {any[]} stack
 */
let drainKids = (node, ctx, stack) => {
  const children = kids(node, ctx);
  while (children.length) stack.push(children.pop());
};

// Node plus all descendants, depth-first. Raw objects on the stack are exit
// markers, keeping cycle detection scoped to the active ancestor path.
/**
 * @param {Loc} node
 * @param {Ctx} ctx
 * @returns {Loc[]}
 */
let all = (
  node,
  ctx,
  out = /** @type {Loc[]} */ ([]),
  stack = /** @type {any[]} */ ([node]),
  seen = new Set(),
) => {
  while (stack.length) {
    node = stack.pop();
    if (seen.delete(node) || !enterObject(node, seen, stack)) continue;
    out.push(node);
    drainKids(node, ctx, stack);
  }
  return out;
};

/**
 * @param {Loc} node
 * @param {any} key
 * @param {Ctx} ctx
 * @returns {Loc[]}
 */
let child = (node, key, ctx, n = node.value) => {
  if (+(n == null) | +(typeof n !== "object") | +BLOCK(key)) return [];
  if (
    Array.isArray(n) &&
    !(+Number.isInteger((key = +key + +(key < 0) * n.length)) & +(key >= 0) & +(key < n.length))
  )
    return [];
  return /** @type {Loc[]} */ ([edge(n, key, node.depth + 1, ctx)].filter((x) => x));
};

/** @type {Record<string, string>} */
const ESC = table({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" });
/**
 * @param {string} raw
 * @param {number} j
 * @param {string} [s]
 */
let hex4 = (raw, j, s = raw.slice(j, j + 4)) => (/^[\da-f]{4}$/i.test(s) ? parseInt(s, 16) : -1);
/**
 * @param {string} raw
 * @param {number} j
 * @param {number} high
 * @param {number} from Offset of the high escape's backslash, for the span.
 * @returns {[string, number]}
 */
let utf16Pair = (raw, j, high, from, low = hex4(raw, j + 3)) =>
  // A missing or invalid low half is the high escape's fault: it is the one
  // that cannot stand alone, so the span is the \uXXXX that needs a partner.
  // oxlint-disable-next-line no-unused-expressions
  (
    +(raw.slice(j + 1, j + 3) === "\\u") & +((low & 0xfc00) === 0xdc00) || bad(from, from + 6),
    [String.fromCharCode(high, low), 6]
  );
/**
 * @param {string} raw
 * @param {number} j
 * @param {number} at Offset of `raw` within the text being parsed.
 * @returns {[string, number]}
 */
let unescapeU = (raw, j, at, from = at + j - 1, a = hex4(raw, j + 1)) => {
  // The escape runs a backslash, a `u`, and four hex digits; only the
  // bad-quad fault can be truncated, so only its span clamps at the closing
  // quote. A lone low surrogate proved all four digits exist.
  // oxlint-disable-next-line no-unused-expressions
  a >= 0 || bad(from, Math.min(from + 6, at + raw.length - 1));
  if ((a & 0xfc00) === 0xd800) {
    const pair = utf16Pair(raw, j + 4, a, from);
    return [pair[0], 4 + pair[1]];
  }
  // oxlint-disable-next-line no-unused-expressions
  (a & 0xfc00) !== 0xdc00 || bad(from, from + 6);
  return [String.fromCharCode(a), 4];
};
/**
 * @param {string} raw
 * @param {number} j
 * @param {string} q
 * @param {number} at Offset of `raw` within the text being parsed.
 * @returns {[string, number]}
 */
let unescape = (raw, j, q, at, ch = ("/\\" + q).includes(raw[j]) ? raw[j] : ESC[raw[j]]) => {
  if (ch) return [ch, 0];
  if (raw[j] === "u") return unescapeU(raw, j, at);
  bad(at + j - 1, at + j + 1);
};
/**
 * @param {string} raw
 * @param {number} j
 * @param {string} c
 * @param {number} at Offset of `raw` within the text being parsed.
 * @returns {[string, number]}
 */
let takeScalar = (raw, j, c, at, a = c.charCodeAt(0)) => {
  if ((a & 0xfc00) === 0xd800) {
    // oxlint-disable-next-line no-unused-expressions
    (raw.charCodeAt(j + 1) & 0xfc00) === 0xdc00 || bad(at + j, at + j + 1);
    return [c + raw[j + 1], 1];
  }
  // oxlint-disable-next-line no-unused-expressions
  (a & 0xfc00) !== 0xdc00 || bad(at + j, at + j + 1);
  return [c, 0];
};
/**
 * @param {string} raw
 * @param {number} j
 * @param {string} q
 * @param {number} at Offset of `raw` within the text being parsed.
 * @returns {[string, number]}
 */
let stepUnq = (raw, j, q, at) => {
  if (raw[j] === "\\") {
    const got = unescape(raw, j + 1, q, at);
    return [got[0], j + 2 + got[1]];
  }
  const c = raw[j];
  // oxlint-disable-next-line no-unused-expressions
  (c >= " " && c !== q) || bad(at + j, at + j + 1);
  const got = takeScalar(raw, j, c, at);
  return [got[0], j + 1 + got[1]];
};

// RFC 9535 quoted string → value. Escaped quotes must match the delimiter,
// and the decoded value must contain only Unicode scalar values.
/**
 * @param {string} raw
 * @param {number} at Offset of `raw` within the text being parsed, so a
 *   fault can span the offending escape rather than the whole literal.
 * @returns {string}
 */
let unq = (raw, at, q = raw[0], end = raw.length - 1) => {
  let out = "",
    j = 1;
  while (j < end) {
    const step = stepUnq(raw, j, q, at);
    out += step[0];
    j = step[1];
  }
  return out;
};

/**
 * @param {string} c
 * @param {number} d
 * @returns {[string | 0, number, number, string?, boolean?]}
 */
let stepBare = (c, d) => {
  if ("\"'".includes(c)) return [c, d, 0];
  if ("[(".includes(c)) return [0, d + 1, 0];
  if ("])".includes(c)) return [0, d - 1, 0, c];
  return [0, d, 0, undefined, !!(+(c == ",") & +!d)];
};
/**
 * @param {string} c
 * @param {string | 0} q
 * @param {number} d
 * @returns {[string | 0, number, number, string?, boolean?]}
 */
let scanBracketChar = (c, q, d) => {
  if (q) {
    if (c === "\\") return [q, d, 1];
    return [c === q ? 0 : q, d, 0];
  }
  return stepBare(c, d);
};
// Index of the `]` matching the `[` at s[j], respecting nesting and strings.
/**
 * @param {string} text
 * @param {number} from
 * @returns {number}
 */
let close = (text, from) => {
  let d = 0,
    /** @type {string | 0} */ q = 0;
  for (let j = from; j < text.length; j++) {
    const step = scanBracketChar(text[j], q, d);
    q = step[0];
    d = step[1];
    j += step[2];
    if (+!step[3] | step[1]) continue;
    if (step[3] === "]") return j;
    break;
  }
  err("Missing ] in path", from, from + 1);
};

/**
 * Split bracket text on commas in a parallel array, each spec's offset already
 * shifted by `base` — the bracket's position in whatever the caller is
 * parsing — so a selector diagnostic points at the selector rather than at the
 * whole bracket, and the offsets cost no per-spec object.
 *
 * @param {string} text
 * @param {number} base
 * @returns {{ specs: string[], ats: number[] }}
 */
let split = (text, base) => {
  const specs = /** @type {string[]} */ ([]),
    ats = /** @type {number[]} */ ([]);
  let d = 0,
    /** @type {string | 0} */ q = 0,
    start = 0;
  // Trimming moves the offset as well as the text.
  /** @type {(raw: string, at: number, lead?: string) => void} */
  const add = (raw, at, lead = raw.trimStart()) => {
    specs.push(lead.trimEnd());
    ats.push(base + at + raw.length - lead.length);
  };
  for (let j = 0; j < text.length; j++) {
    const step = scanBracketChar(text[j], q, d);
    q = step[0];
    d = step[1];
    j += step[2];
    if (step[4]) {
      add(text.slice(start, j), start);
      start = j + 1;
    }
  }
  add(text.slice(start), start);
  return { specs, ats };
};

/** @returns {Sel} */
/**
 * @param {string} spec
 * @param {number} at Offset of `spec` within the query, for diagnostics.
 * @returns {Sel}
 */
let nameOrIndex = (spec, at, quoted = /^(['"])([\s\S]*)\1$/.test(spec)) => {
  if (quoted) {
    const key = unq(spec, at);
    return {
      r: (n, root, ctx) => (Array.isArray(n.value) ? [] : child(n, key, ctx)),
      t: ["name", key],
    };
  }
  if (/^-?\d+$/.test(spec))
    return {
      r: (n, root, ctx) => (Array.isArray(n.value) ? child(n, spec, ctx) : []),
      t: ["index", +spec || 0],
    };
  return err("Bad selector [" + spec + "]", at, at + spec.length);
};
/**
 * @param {string} raw
 * @param {number} len
 * @param {number} fallback
 * @param {number} lo
 * @param {number} hi
 */
let sliceBound = (
  raw,
  len,
  fallback,
  lo,
  hi,
  n = raw ? (+raw < 0 ? +raw + len : +raw) : fallback,
) => Math.min(Math.max(n, lo), hi);
/**
 * @param {Loc} node
 * @param {Ctx} ctx
 * @param {string} start
 * @param {string} end
 * @param {number} step
 * @param {Loc[]} out
 */
let sliceFwd = (node, ctx, start, end, step, out, len = node.value.length) => {
  const lo = sliceBound(start, len, 0, 0, len);
  const hi = sliceBound(end, len, len, 0, len);
  for (let j = lo; j < hi; j += step) put(out, node.value, j, node.depth + 1, ctx);
};
/**
 * @param {Loc} node
 * @param {Ctx} ctx
 * @param {string} start
 * @param {string} end
 * @param {number} step
 * @param {Loc[]} out
 */
let sliceBack = (node, ctx, start, end, step, out, len = node.value.length) => {
  const hi = sliceBound(start, len, len - 1, -1, len - 1);
  const lo = sliceBound(end, len, -1, -1, len - 1);
  for (let j = hi; j > lo; j += step) put(out, node.value, j, node.depth + 1, ctx);
};
/**
 * @param {RegExpExecArray} m
 * @returns {Sel}
 */
let sliceSel = (m, step = m[3] ? +m[3] : 1) => ({
  t: ["slice", m[1] ? +m[1] : null, m[2] ? +m[2] : null, step],
  r: (node, root, ctx) => {
    if (+!Array.isArray(node.value) | +!step) return [];
    const out = /** @type {Loc[]} */ ([]);
    if (step > 0) sliceFwd(node, ctx, m[1], m[2], step, out);
    else sliceBack(node, ctx, m[1], m[2], step, out);
    return out;
  },
});

// One selector inside `[...]` → executor plus dependency-topology tuple.
/**
 * @param {string} spec
 * @param {Record<string, Function>} registry
 * @param {any} info
 * @param {number} at Offset of `spec` within the query, for diagnostics.
 * @returns {Sel}
 */
let selector = (
  spec,
  registry,
  info,
  at,
  sliceMatch = /^(-?\d*)\s*:\s*(-?\d*)(?:\s*:\s*(-?\d+)?)?$/.exec(spec),
) => {
  if (spec === "*") return { r: (n, root, ctx) => kids(n, ctx), t: ["wildcard"] };
  if (spec[0] === "?") {
    const test = rfcFilter(spec.slice(1), registry, info, at + 1);
    return {
      r: (n, root, ctx) => kids(n, ctx).filter((c) => test(c.value, root, ctx)),
      t: ["filter"],
    };
  }
  if (sliceMatch) return sliceSel(sliceMatch);
  return nameOrIndex(spec, at);
};

/**
 * @param {string} s
 * @param {number} i
 * @returns {number}
 */
let skip = (s, i, m = /** @type {RegExpExecArray} */ (/^\s*/.exec(s.slice(i)))) => i + m[0].length;
/**
 * @param {string} path
 * @param {number} j
 * @returns {[boolean, number] | null}
 */
let segPrefix = (path, j) => {
  if (path.startsWith("..", j)) return [true, j + 2];
  if (path[j] === ".") return [false, j + 1];
  if (path[j] === "[") return [false, j];
  return null;
};
/**
 * @param {string} path
 * @param {number} j
 * @param {number} back
 * @param {boolean} soft
 * @param {Seg[]} segs
 */
let unexpectedSeg = (path, j, back, soft, segs) =>
  // oxlint-disable-next-line no-unused-expressions
  (soft || err('Unexpected "' + path[j] + '" in path', j, j + 1), { segs, j: back });
/**
 * @param {string} path
 * @param {number} j
 * @param {boolean} desc
 * @param {Record<string, Function>} registry
 * @param {any} info
 * @param {any[]} dep
 * @returns {[number, Seg]}
 */
let bracketSeg = (path, j, desc, registry, info, dep) => {
  const end = close(path, j);
  const { specs: raw, ats } = split(path.slice(j + 1, end), j + 1);
  const sels = raw.map((spec, x) => selector(spec, registry, info, ats[x]));
  const m = raw.length === 1 ? sels[0].t : ["union", ...sels.map((s) => s.t)];
  dep.push(desc ? ["descendant", m] : m);
  return [
    end + 1,
    {
      d: desc,
      s: !!(+!desc & +(raw.length === 1) & (+/^-?\d+$/.test(raw[0]) | +/^["']/.test(raw[0]))),
      f: (ns, root, ctx) => ns.flatMap((n) => sels.flatMap((sel) => sel.r(n, root, ctx))),
    },
  ];
};
/**
 * @param {string} path
 * @param {number} j
 * @param {boolean} desc
 * @param {any[]} dep
 * @returns {[number, Seg]}
 */
let identSeg = (
  path,
  j,
  desc,
  dep,
  m = /^(\*|[A-Za-z_\u{80}-\u{10FFFF}][\w\u{80}-\u{10FFFF}]*)/u.exec(path.slice(j)) ||
    err("Bad path near index " + j, j, Math.min(j + 1, path.length)),
  key = m[1],
  x = key === "*" ? ["wildcard"] : ["name", key],
) => (
  dep.push(desc ? ["descendant", x] : x),
  [
    j + key.length,
    {
      d: desc,
      s: !!(+!desc & +(key !== "*")),
      f: (ns, root, ctx) => ns.flatMap((n) => (key === "*" ? kids(n, ctx) : child(n, key, ctx))),
    },
  ]
);

// Parse consecutive segments starting at index `j`; returns the compiled
// segments plus where parsing stopped. Top level (`soft` false) errors on any
// unexpected character. Soft mode instead stops at the first character that
// cannot start a segment, so embedded queries inside filters can end
// mid-string (before an operator, `)`, `]`, or `,`).
/**
 * @param {string} path
 * @param {number} j
 * @param {Record<string, Function>} registry
 * @param {boolean} soft
 * @param {any} info
 * @param {any[]} dep
 * @returns {{ segs: Seg[], j: number }}
 */
let segments = (path, j, registry, soft, info, dep) => {
  const segs = /** @type {Seg[]} */ ([]);
  while (j < path.length) {
    const back = j;
    j = skip(path, j);
    const prefix = segPrefix(path, j);
    if (!prefix) return unexpectedSeg(path, j, back, soft, segs);
    const next =
      path[prefix[1]] === "["
        ? bracketSeg(path, prefix[1], prefix[0], registry, info, dep)
        : identSeg(path, prefix[1], prefix[0], dep);
    segs.push(next[1]);
    j = next[0];
  }
  return { segs, j };
};

// Run compiled segments over a start nodelist.
/**
 * @param {Seg[]} segs
 * @param {any} start
 * @param {any} root
 * @param {Ctx} ctx
 * @returns {Loc[]}
 */
let run = (
  segs,
  start,
  root,
  ctx,
  nodes = segs.reduce(
    (acc, s) => s.f(s.d ? acc.flatMap((n) => all(n, ctx)) : acc, root, ctx),
    [loc(start, 0, ctx)],
  ),
  // oxlint-disable-next-line no-unused-expressions
) =>
  (limit(ctx, 2, nodes.length), nodes);

// ---- RFC 9535 filter grammar ----
// Missing values are a distinct "Nothing", not undefined: undefined is a
// value JS data can actually hold.
const NOTHING = Symbol();

// Deep structural equality per RFC 9535. Own keys only, through the guard,
// so `__proto__` keys in data stay inert here too. An explicit pair stack
// keeps deep documents off the native call stack, and a hard step cap bounds
// pathological (or cyclic) comparisons with a typed diagnostic.
const EQ_STEPS = 1e6;
/**
 * @param {any[]} stack
 * @param {any} left
 * @param {any} right
 */
let deepStep = (stack, left, right) => {
  if (left === right) return true;
  if (
    !(
      +!!left &
      +!!right &
      +(typeof left === "object") &
      +(typeof right === "object") &
      +(Array.isArray(left) === Array.isArray(right))
    )
  )
    return false;
  const keysLeft = ownKeys(left),
    keysRight = ownKeys(right);
  return (
    +(keysLeft.length === keysRight.length) & +(left.length === right.length) &&
    keysLeft.every((key) => Object.hasOwn(right, key) && (stack.push(left[key], right[key]), !0))
  );
};
/**
 * @param {any} left
 * @param {any} right
 * @returns {boolean}
 */
let deepEq = (left, right, stack = [left, right]) => {
  let steps = 0;
  while (stack.length) {
    if (++steps > EQ_STEPS) cap("maxComparisons", "PADVINDER_MAX_COMPARISONS", EQ_STEPS, steps);
    const rightValue = stack.pop(),
      leftValue = stack.pop();
    if (!deepStep(stack, leftValue, rightValue)) return false;
  }
  return true;
};

/**
 * @param {any} left
 * @param {any} right
 */
let ordered = (left, right) =>
  typeof left === typeof right &&
  (typeof left === "number" || typeof left === "string") &&
  left < right;
/**
 * @param {any} left
 * @param {any} right
 */
let eq = (left, right) =>
  left === NOTHING || right === NOTHING ? left === right : deepEq(left, right);
/** @type {Record<string, (left: any, right: any) => boolean>} */
const CMP = {
  "==": eq,
  "!=": (left, right) => !eq(left, right),
  "<=": (left, right) => eq(left, right) || ordered(left, right),
  ">=": (left, right) => eq(left, right) || ordered(right, left),
  "<": ordered,
  ">": (left, right) => ordered(right, left),
};
/**
 * @param {boolean} full
 * @returns {{ a: number[], r: number, f: (args: Arg[]) => Arg }}
 */
const reFn = (full) => ({
  a: [0, 0],
  r: 2,
  f:
    ([a, b]) =>
    (n, r, ctx) =>
      reTest(a(n, r, ctx), b(n, r, ctx), full),
});

// The five built-in RFC function extensions with their argument and return
// types. A name absent here is looked up in the caller's registry instead.
/** @type {Record<string, { a: number[], r: number, f: (args: Arg[]) => Arg }>} */
const RFCFN = table({
  length: {
    a: [0],
    r: 0,
    f:
      ([a]) =>
      (n, r, ctx, v = a(n, r, ctx)) =>
        typeof v === "string"
          ? // RFC 9535 counts a string's Unicode scalar values, which is what
            // spreading yields — `no-misused-spread` is warning about the
            // grapheme clusters the function deliberately does not count.
            // oxlint-disable-next-line typescript/no-misused-spread
            [...v].length
          : Array.isArray(v)
            ? v.length
            : +!!v & +(typeof v === "object")
              ? Object.keys(v).length
              : NOTHING,
  },
  count: {
    a: [1],
    r: 0,
    f:
      ([a]) =>
      (n, r, ctx) =>
        a(n, r, ctx).length,
  },
  value: {
    a: [1],
    r: 0,
    f:
      ([a]) =>
      (n, r, ctx, ns = a(n, r, ctx)) =>
        ns.length === 1 ? ns[0] : NOTHING,
  },
  match: reFn(!0),
  search: reFn(!1),
});

const ws = () => (k = skip(source, k));
/** @param {string} c */
const eat = (c) => source.startsWith(c, k) && (k += c.length);
/** @param {string} c */
const expect = (c) => eat(c) || fail();

// `@` or `$` plus segments; runs to a nodelist.
/** @returns {{ s: boolean, f: (n: any, r: any, ctx: Ctx) => Loc[] }} */
const queryExpr = (abs = source[k++] === "$", dep = [abs ? "$" : "@"]) => {
  meta.p.push(dep);
  const { segs, j } = segments(source, k, fns, !0, meta, dep);
  k = j;
  return {
    s: segs.every((s) => s.s),
    f: (n, r, ctx) => run(segs, abs ? r : n, r, ctx),
  };
};

/** @returns {Arg | undefined} */
let litNumber = (m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(k))) =>
  !m || /[\w.]/.test(source[k + m[0].length] || "") ? undefined : ((k += m[0].length), () => +m[0]);
/**
 * @param {string} q
 * @param {number} j
 */
let closeQuote = (q, j) => {
  for (; j < source.length && source[j] !== q; j++) if (source[j] === "\\") j++;
  return j;
};
/** @returns {Arg | undefined} */
let litString = (q = source[k]) => {
  if (q !== '"' && q !== "'") return;
  // `close()` only yields bracket text when quotes are balanced, so the closer
  // is always present here — an unclosed filter string fails as Missing ] first.
  const j = closeQuote(q, k + 1);
  const v = unq(source.slice(k, j + 1), k);
  k = j + 1;
  return () => v;
};
// Literal number, string, or keyword; undefined when none matches.
/** @returns {Arg | undefined} */
const literal = (m = /^(true|false|null)\b/.exec(source.slice(k))) =>
  litNumber() || litString() || (m ? ((k += m[0].length), () => JSON.parse(m[0])) : undefined);

/**
 * @param {{ s: boolean, f: (n: any, r: any, ctx: Ctx) => Loc[] }} q
 * @returns {Arg}
 */
let singularVal =
  (q) =>
  (n, r, ctx, ns = q.f(n, r, ctx)) =>
    ns.length ? ns[0].value : NOTHING;
/** @param {number} type @returns {Arg} */
let queryArg = (type, q = queryExpr()) => {
  if (type === 1) return (n, r, ctx) => q.f(n, r, ctx).map((x) => x.value);
  // oxlint-disable-next-line no-unused-expressions
  q.s || fail();
  return singularVal(q);
};
/** @returns {Arg} */
let valueArg = (lit = literal()) => {
  if (lit) return lit;
  const f = funcExpr();
  // oxlint-disable-next-line no-unused-expressions
  f.t === 0 || fail();
  return f.f;
};
// name(args) with RFC typing; `arg` parses one argument of the given type.
/**
 * @param {number} type
 * @returns {Arg}
 */
const arg = (type) => {
  ws();
  if ("@$".includes(source[k])) return queryArg(type);
  // oxlint-disable-next-line no-unused-expressions
  type === 1 && fail();
  return valueArg();
};
let restArgs = () => {
  const args = /** @type {Arg[]} */ ([]);
  do args.push(arg(0));
  while ((ws(), eat(",")));
  ws();
  expect(")");
  return args;
};
/**
 * @param {string} name
 * @param {number} from Offset of `name` within the filter, for diagnostics.
 * @returns {{ t: number, f: Arg }}
 */
let userArgs = (name, from, f = fns[name]) => {
  // oxlint-disable-next-line no-unused-expressions
  Object.hasOwn(fns, name) || err(name + " is not a function", from, from + name.length);
  // oxlint-disable-next-line no-unused-expressions
  meta.f.includes(name) || meta.f.push(name);
  ws();
  const args = eat(")") ? [] : restArgs();
  return { t: 3, f: (n, r, ctx) => f(...args.map((a) => a(n, r, ctx))) };
};
/** @returns {{ t: number, f: Arg }} */
const funcExpr = (
  m = /^[a-z][a-z0-9_]*/.exec(source.slice(k)) || fail(),
  from = k,
  spec = ((k += m[0].length), ws(), expect("("), RFCFN[m[0]]),
) => {
  if (!spec) return userArgs(m[0], from);
  // oxlint-disable-next-line no-unused-vars
  const args = spec.a.map((t, x) => (x && (ws(), expect(",")), arg(t)));
  ws();
  expect(")");
  return { t: spec.r, f: spec.f(args) };
};

/** @param {{ t: number, f: Arg }} f */
let asPrim = (f) => (f.t === 2 ? { l: f.f } : f.t === 3 ? { v: f.f, u: !0 } : { v: f.f });
// A comparable/test primary: query, literal, or function call.
/** @returns {Prim} */
const primary = () => {
  ws();
  if ("@$".includes(source[k])) return { q: queryExpr() };
  const lit = literal();
  return lit ? { v: lit } : asPrim(funcExpr());
};
// ValueType position: literals, value functions, and singular queries only.
/**
 * @param {Prim} prim
 * @returns {Arg}
 */
const asValue = (prim, q = prim.q) => {
  if (prim.v) return prim.v;
  // oxlint-disable-next-line no-unused-expressions
  (q && q.s) || fail();
  return singularVal(/** @type {NonNullable<Prim['q']>} */ (q));
};

let maybeNeg = (neg = !1) => {
  while (eat("!")) {
    // oxlint-disable-next-line no-unused-expressions
    ((neg = !neg), ws());
  }
  return neg;
};
/**
 * @param {Prim} p
 * @returns {Arg}
 */
let asTest = (p) => {
  if (p.q) {
    const q = p.q;
    return (n, r, ctx) => q.f(n, r, ctx).length > 0;
  }
  if (p.u) return /** @type {Arg} */ (p.v);
  return p.l || fail();
};
/**
 * @param {boolean} neg
 * @param {Arg} t
 * @returns {Arg}
 */
let negate = (neg, t) => (neg ? (n, r, ctx) => !t(n, r, ctx) : t);

/** @returns {Arg} */
const basic = () => {
  ws();
  const neg = maybeNeg();
  if (eat("(")) {
    const e = or();
    ws();
    expect(")");
    return negate(neg, e);
  }
  const p = primary();
  ws();
  const op = Object.keys(CMP).find((o) => source.startsWith(o, k));
  if (op) {
    // oxlint-disable-next-line no-unused-expressions
    neg && fail();
    const a = ((k += op.length), asValue(p)),
      b = asValue(primary());
    return (n, r, ctx) => CMP[op](a(n, r, ctx), b(n, r, ctx));
  }
  return negate(neg, asTest(p));
};
/** @returns {Arg} */
const and = (l = basic()) => {
  for (ws(); eat("&&"); ws()) {
    const a = l,
      b = basic();
    l = (n, r, ctx) => a(n, r, ctx) && b(n, r, ctx);
  }
  return l;
};
/** @returns {Arg} */
const or = (l = and()) => {
  for (ws(); eat("||"); ws()) {
    const a = l,
      b = and();
    l = (n, r, ctx) => a(n, r, ctx) || b(n, r, ctx);
  }
  return l;
};

// Parse one filter body as the RFC grammar, producing (node, root) => boolean.
// Throws SyntaxError on anything that is not valid RFC 9535 filter syntax.
/**
 * @param {string} src
 * @param {Record<string, Function>} registry
 * @param {any} info
 * @param {number} at Offset of `src` within the query, for diagnostics.
 * @returns {Test}
 */
let rfcFilter = (src, registry, info, at, prev = [source, k, fns, meta, base]) => {
  source = src;
  k = 0;
  base += at;
  fns = registry;
  meta = info;
  try {
    const e = or();
    ws();
    // oxlint-disable-next-line no-unused-expressions
    k === source.length || fail();
    return e;
  } finally {
    [source, k, fns, meta, base] = prev;
  }
};

/**
 * @template T
 * @param {T} x
 * @returns {T}
 */
// oxlint-disable-next-line no-unused-expressions
let freeze = (x) => (Array.isArray(x) && x.forEach(freeze), Object.freeze(x));

/**
 * @param {any} options
 * @returns {Record<string, any>}
 */
let asOptions = (options) => {
  if (options == null) return {};
  if (typeof options !== "object" || Array.isArray(options))
    throw fault(TypeError, "options must be an object");
  return options;
};
/** @param {Record<string, any>} options */
let checkOpts = (options) => {
  for (const key of Object.keys(options)) {
    if (!LIMITS.includes(key)) throw fault(TypeError, 'Unknown option "' + key + '"');
    checkBudget(key, options[key]);
  }
};
/**
 * @param {string} key
 * @param {any} value
 */
let checkBudget = (key, value) => {
  if (typeof value !== "number") throw fault(TypeError, key + " must be a number");
  if (!Number.isSafeInteger(value) || value < 0)
    throw fault(RangeError, key + " must be a non-negative safe integer");
};

/**
 * Compile a JSONPath query once, run it many times.
 * The runner exposes frozen `paths`/`functions` metadata and a runner-scoped
 * `isDiagnostic(error)` predicate for runtime faults it creates.
 *
 * @param {string} path The query, e.g. `'$.store.book[?@.price < 10].title'`.
 * @param {Record<string, Function>} [funcs] Custom function extensions callable in filters, alongside the built-in `length`, `count`, `value`, `match`, and `search`.
 * @param {{maxNodes?: number, maxDepth?: number, maxResults?: number}} [options] Optional per-execution traversal budgets.
 * @returns {(data?: any) => any[]} Runner returning all matches (empty array for none).
 * @throws {SyntaxError|TypeError|RangeError} On malformed queries, options, or exhausted budgets.
 */
export function query(path, funcs, options) {
  funcs = funcs || {};
  const opts = asOptions(options);
  checkOpts(opts);
  // Parsing works on the trimmed query, but a span belongs to the string the
  // caller handed in, so the leading whitespace it dropped is where the
  // coordinates start. Every compile entry is this one, so setting the base
  // here — rather than restoring it — is enough.
  const raw = String(path);
  path = raw.trimStart();
  base = raw.length - path.length;
  path = path.trimEnd();
  // oxlint-disable-next-line no-unused-expressions
  path[0] === "$" || err("Path must start with $", 0, Math.min(1, path.length));
  const info = { p: /** @type {any[]} */ ([["$"]]), f: /** @type {string[]} */ ([]) };
  const { segs } = segments(path, 1, funcs, false, info, info.p[0]);
  const limits = LIMITS.map((key) => opts[key]);
  const tuple = limits.some((x) => x !== undefined) ? limits : null;
  const own = {};
  const runner = (/** @type {any} */ data, ctx = tuple ? [...tuple, 0, own] : null) =>
    run(segs, data, data, ctx).map((x) => x.value);
  runner.paths = freeze(
    [
      ...new Map(info.p.map((x) => /** @type {[string, any]} */ ([JSON.stringify(x), x]))).values(),
    ].map(freeze),
  );
  runner.functions = freeze(info.f);
  runner.isDiagnostic = (/** @type {any} */ e) => origin(e) === own;
  return runner;
}

/**
 * Compile and run a JSONPath query in one go.
 *
 * @param {string} path The query to run.
 * @param {any} [data] The data to query.
 * @param {Record<string, Function>} [funcs] Functions callable inside filters.
 * @param {{maxNodes?: number, maxDepth?: number, maxResults?: number}} [options] Optional per-execution traversal budgets.
 * @returns {any[]} All matches (empty array for none).
 */
export function find(path, data, funcs, options) {
  return query(path, funcs, options)(data);
}
