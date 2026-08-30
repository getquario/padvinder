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
/**
 * The one "is this a node with children" test, shared by every traversal,
 * guard, and type-dependent function so the null case is decided in one place.
 *
 * @param {any} v
 * @returns {boolean}
 */
const isObj = (v) => !!v && typeof v === "object";
const LIMITS = ["maxNodes", "maxDepth", "maxResults"];
// The default depth budget, applied when the caller sets none.
const DEPTH = 500;
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
// The one treffer compile configuration, shared by the row-time cache and the
// compile-time literal check so the two can never diverge.
const RE_OPTS = { anchors: true };
/** @param {string} p */
let reFresh = (p) => {
  if (p === reLast) return;
  reLast = p;
  reNfa = null;
  reNfa = compileRE(p, RE_OPTS);
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
  if (!isObj(value)) return out;
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
  if (isObj(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    stack.push(value);
  }
  return true;
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
    // Children go on back to front, so the stack pops them in document order.
    kids(node, ctx).reduceRight((into, kid) => (into.push(kid), into), stack);
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
  if (+!isObj(n) | +BLOCK(key)) return [];
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
 * The surrogate rule both string readers obey, in one place: a high half must
 * be followed by a low one, and a low half that stands alone is not a Unicode
 * scalar value. Either fault is the first half's — it is the one that cannot
 * stand alone — so both span `[from, to)`, and a `low` that is not there at
 * all arrives as -1.
 *
 * @param {number} a The code unit being read.
 * @param {number} low The code unit after it.
 * @param {number} from
 * @param {number} to
 * @returns {boolean} Whether `a` opened a pair, so the reader takes both.
 */
let pairs = (a, low, from, to) => {
  if ((a & 0xfc00) === 0xd800) {
    // oxlint-disable-next-line no-unused-expressions
    (low & 0xfc00) === 0xdc00 || bad(from, to);
    return true;
  }
  // oxlint-disable-next-line no-unused-expressions
  (a & 0xfc00) !== 0xdc00 || bad(from, to);
  return false;
};
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
  // The low half has to be a second escape; anything else is no low half.
  const low = raw.slice(j + 5, j + 7) === "\\u" ? hex4(raw, j + 7) : -1;
  return pairs(a, low, from, from + 6)
    ? [String.fromCharCode(a, low), 10]
    : [String.fromCharCode(a), 4];
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
  +(c >= " ") & +(c !== q) || bad(at + j, at + j + 1);
  // A surrogate pair is one scalar value, so it steps two code units at once.
  return pairs(c.charCodeAt(0), raw.charCodeAt(j + 1), at + j, at + j + 1)
    ? [c + raw[j + 1], j + 2]
    : [c, j + 1];
};

// RFC 9535 quoted string → value. Escaped quotes must match the delimiter,
// and the decoded value must contain only Unicode scalar values.
/**
 * @param {string} raw
 * @param {number} at Offset of `raw` within the text being parsed, so a
 *   fault can span the offending escape rather than the whole literal.
 * @returns {string}
 */
let unq = (raw, at, q = raw[0], end = raw.length - 1, out = "", j = 1) => {
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

/**
 * A bracket key is RFC-typed: a quoted name selects from objects only, an
 * index from arrays only. That makes both the same guarded child lookup, run
 * under opposite answers to "is this node an array?" — and a spec that is
 * neither spelling is a bad selector.
 *
 * @param {string} spec
 * @param {number} at Offset of `spec` within the query, for diagnostics.
 * @returns {Sel}
 */
let nameOrIndex = (
  spec,
  at,
  quoted = /^(['"])([\s\S]*)\1$/.test(spec),
  key = quoted ? unq(spec, at) : spec,
) => {
  if (+!quoted & +!/^-?\d+$/.test(spec)) err("Bad selector [" + spec + "]", at, at + spec.length);
  return {
    r: (n, root, ctx) => (Array.isArray(n.value) === !quoted ? child(n, key, ctx) : []),
    // `+ 0` is the `-0` that `+"-0"` produces, normalized for the topology.
    t: quoted ? ["name", key] : ["index", +spec + 0],
  };
};
/**
 * One RFC 9535 slice bound: an absent bound falls back, a negative one counts
 * from the end, and the result clamps into the window its direction runs in —
 * `[0, len]` walking up, `[-1, len - 1]` walking down, which is what the `up`
 * term shifts both ends of.
 *
 * @param {string} raw
 * @param {number} len
 * @param {number} fallback
 * @param {number} up 1 walking up, 0 walking down.
 */
let sliceBound = (raw, len, fallback, up, n = raw ? (+raw < 0 ? +raw + len : +raw) : fallback) =>
  Math.min(Math.max(n, up - 1), len - 1 + up);
/**
 * The RFC 9535 slice, either direction: one half-open walk from `start`
 * towards `end`. The sign of `step` picks the direction, and with it the
 * defaults for absent bounds and the sense of the comparison that ends the
 * walk — `(to - j) * step > 0` is `j < to` walking up and `j > to` walking
 * down.
 *
 * @param {Loc} node
 * @param {Ctx} ctx
 * @param {string} start
 * @param {string} end
 * @param {number} step
 * @param {Loc[]} out
 */
let slice = (node, ctx, start, end, step, out, len = node.value.length, up = +(step > 0)) => {
  const ends = up ? [0, len] : [len - 1, -1];
  const from = sliceBound(start, len, ends[0], up);
  const to = sliceBound(end, len, ends[1], up);
  for (let j = from; (to - j) * step > 0; j += step) put(out, node.value, j, node.depth + 1, ctx);
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
    slice(node, ctx, m[1], m[2], step, out);
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
 * One compiled segment plus its entry in the dependency topology, which is
 * where both segment kinds meet: a descendant segment wraps its topology in
 * `["descendant", …]` and is never singular, and `each` is the per-node
 * selection the segment maps the incoming nodelist over.
 *
 * @param {any[]} dep
 * @param {boolean} desc
 * @param {any[]} topo
 * @param {number} sing 1 when the segment selects at most one node.
 * @param {(n: Loc, root: any, ctx: Ctx) => Loc[]} each
 * @returns {Seg}
 */
let makeSeg = (dep, desc, topo, sing, each) => (
  dep.push(desc ? ["descendant", topo] : topo),
  { d: desc, s: !!(+!desc & sing), f: (ns, root, ctx) => ns.flatMap((n) => each(n, root, ctx)) }
);
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
  const sing = +(raw.length === 1) & (+/^-?\d+$/.test(raw[0]) | +/^["']/.test(raw[0]));
  return [
    end + 1,
    makeSeg(dep, desc, m, sing, (n, root, ctx) => sels.flatMap((sel) => sel.r(n, root, ctx))),
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
  star = key === "*",
) => [
  j + key.length,
  makeSeg(dep, desc, star ? ["wildcard"] : ["name", key], +!star, (n, root, ctx) =>
    star ? kids(n, ctx) : child(n, key, ctx),
  ),
];

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
 * A pair goes onto the stack left first, so it comes back off right first —
 * which is the order the two `pop()`s at the one call site read in.
 *
 * @param {any[]} stack
 * @param {any} right
 * @param {any} left
 */
let deepStep = (stack, right, left) => {
  if (left === right) return true;
  if (!(+isObj(left) & +isObj(right) & +(Array.isArray(left) === Array.isArray(right))))
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
    if (!deepStep(stack, stack.pop(), stack.pop())) return false;
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
 * @returns {Fn}
 */
const reFn = (full) => ({
  a: [0, 0],
  r: 2,
  // A quoted-literal pattern is compiled now: a bad I-Regexp written in the
  // query text is a located compile fault at the literal, while a pattern
  // that arrives from data stays a row-time false — RFC semantics untouched.
  c: (args, at, end, p = /** @type {any} */ (args[1]).lit) => {
    if (typeof p !== "string") return;
    try {
      compileRE(p, RE_OPTS);
    } catch (e) {
      if (!isREDiagnostic(e)) throw e;
      err(/** @type {Error} */ (e).message, at[1], end);
    }
  },
  f:
    ([a, b]) =>
    (n, r, ctx) =>
      reTest(a(n, r, ctx), b(n, r, ctx), full),
});

// The five built-in RFC function extensions with their argument and return
// types, plus an optional compile-time check `c` over the parsed args and
// their source offsets. A name absent here is looked up in the caller's
// registry instead.
/**
 * @typedef {{ a: number[], r: number, f: (args: Arg[]) => Arg,
 *   c?: (args: Arg[], at: number[], end: number) => void }} Fn
 */
/**
 * A built-in over exactly one argument: `type` is that argument's RFC type,
 * `ret` the return type, and `of` turns what the compiled argument produced
 * into the function's value.
 *
 * @param {number} type
 * @param {number} ret
 * @param {(v: any) => any} of
 * @returns {Fn}
 */
let unaryFn = (type, ret, of) => ({
  a: [type],
  r: ret,
  f:
    ([a]) =>
    (n, r, ctx) =>
      of(a(n, r, ctx)),
});
/**
 * RFC 9535 `length()`: a string's Unicode scalar values, an array's elements,
 * an object's members, and NOTHING for anything else.
 *
 * @param {any} v
 */
let lengthOf = (v) =>
  typeof v === "string"
    ? // Spreading yields exactly those scalar values — `no-misused-spread` is
      // warning about the grapheme clusters the function deliberately does not
      // count.
      // oxlint-disable-next-line typescript/no-misused-spread
      [...v].length
    : Array.isArray(v)
      ? v.length
      : isObj(v)
        ? Object.keys(v).length
        : NOTHING;
/** @type {Record<string, Fn>} */
const RFCFN = table({
  length: unaryFn(0, 0, lengthOf),
  count: unaryFn(1, 0, (ns) => ns.length),
  value: unaryFn(1, 0, (ns) => (ns.length === 1 ? ns[0] : NOTHING)),
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
  // Stamped with its value: a consumer that must act on a string literal at
  // compile time (reFn's pattern check) keys off the Arg itself rather than
  // re-deriving literalness from the source text.
  return Object.assign(() => v, { lit: v });
};
// Literal number, string, or keyword; undefined when none matches.
/** @returns {Arg | undefined} */
const literal = (m = /^(true|false|null)\b/.exec(source.slice(k))) =>
  litNumber() || litString() || (m ? ((k += m[0].length), () => JSON.parse(m[0])) : undefined);

/**
 * The value of a query in ValueType position: a query stands for a value only
 * when it is singular, so the demand and the value it unlocks are one step —
 * the single node's value, or NOTHING when the query selected none. Every
 * ValueType position goes through here, filter argument and comparison alike.
 *
 * @param {Prim['q']} q
 * @param {NonNullable<Prim['q']>} [one] `q` once it has been demanded singular.
 * @returns {Arg}
 */
let singularVal = (q, one = /** @type {any} */ (q)) =>
  // oxlint-disable-next-line no-unused-expressions
  ((q && q.s) || fail(), (n, r, ctx, ns = one.f(n, r, ctx)) => (ns.length ? ns[0].value : NOTHING));
/** @param {number} type @returns {Arg} */
let queryArg = (type, q = queryExpr()) =>
  type === 1 ? (n, r, ctx) => q.f(n, r, ctx).map((x) => x.value) : singularVal(q);
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
  const at = /** @type {number[]} */ ([]);
  // oxlint-disable-next-line no-unused-vars
  const args = spec.a.map((t, x) => (x && (ws(), expect(",")), ws(), at.push(k), arg(t)));
  // oxlint-disable-next-line no-unused-expressions
  spec.c && spec.c(args, at, k);
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
const asValue = (prim) => prim.v || singularVal(prim.q);

let maybeNeg = (neg = !1) => {
  // oxlint-disable-next-line no-unused-expressions
  while (eat("!")) ((neg = !neg), ws());
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
/**
 * One left-associative level of the filter grammar: parse a `next` operand,
 * then fold every further `op`-separated operand into it with `join`. `join`
 * combines the two compiled expressions rather than their results, so the
 * operator keeps short-circuiting at row time.
 *
 * @param {() => Arg} next
 * @param {string} op
 * @param {(a: Arg, b: Arg) => Arg} join
 * @returns {Arg}
 */
let chain = (next, op, join, l = next()) => {
  for (ws(); eat(op); ws()) l = join(l, next());
  return l;
};
/** @returns {Arg} */
const and = () => chain(basic, "&&", (a, b) => (n, r, ctx) => a(n, r, ctx) && b(n, r, ctx));
/** @returns {Arg} */
const or = () => chain(and, "||", (a, b) => (n, r, ctx) => a(n, r, ctx) || b(n, r, ctx));

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
 * One budget slot: the caller's checked value, `fallback` filling an absent
 * one, and an explicit Infinity opting out — normalized to the undefined slot
 * `limit()` already reads as unbounded.
 *
 * @param {any} value
 * @param {number} [fallback]
 */
let slot = (value, fallback, v = value === undefined ? fallback : value) =>
  v === Infinity ? undefined : v;

/**
 * The per-run budget tuple, or null for the no-budget fast path. Safety by
 * construction: depth defaults to 500, so a deep
 * untrusted document throws a typed diagnostic instead of overflowing the
 * native stack; all-Infinity normalizes to no tuple, keeping the fast path.
 *
 * @param {Record<string, any>} opts
 */
let budgetTuple = (opts) => {
  const limits = LIMITS.map((key) => slot(opts[key], key === "maxDepth" ? DEPTH : undefined));
  return limits.some((x) => x !== undefined) ? limits : null;
};

/**
 * Infinity is the deliberate opt-out spelling: this budget, unbounded. The
 * validity test is a bitwise conjunction because neither half can throw and
 * the branchless form keeps this function inside the complexity budget.
 *
 * @param {string} key
 * @param {any} value
 */
let checkBudget = (key, value) => {
  if (typeof value !== "number") throw fault(TypeError, key + " must be a number");
  if (!(+(value === Infinity) | (+Number.isSafeInteger(value) & +(value >= 0))))
    throw fault(RangeError, key + " must be a non-negative safe integer or Infinity");
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
  const tuple = budgetTuple(opts);
  const own = {};
  const runner = (/** @type {any} */ data, ctx = tuple ? [...tuple, 0, own] : null) =>
    run(segs, data, data, ctx).map((x) => x.value);
  // Freezing the outer array reaches every nested tuple on its own.
  const unique = new Map(info.p.map((x) => /** @type {[string, any]} */ ([JSON.stringify(x), x])));
  runner.paths = freeze([...unique.values()]);
  runner.functions = freeze(info.f);
  // The RFC 9535 singularity fold `queryExpr` already runs for embedded
  // queries, surfaced for the top level: every segment selects at most one
  // node, so the whole query selects at most one.
  runner.singular = segs.every((s) => s.s);
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
