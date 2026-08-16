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
 * @typedef {{ run: (n: Loc, root: any, ctx: Ctx) => Loc[], topology: any[] }} Sel
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
 * @param {(msg: string) => Error} Type
 * @param {string} msg
 * @param {any} [own]
 * @returns {Error}
 */
let fault = (Type, msg, own) => {
  const e = Type(msg);
  return (mark(e, own), e);
};
/** @type {(m: string) => never} */
const err = (m) => {
  throw fault(SyntaxError, m);
};

// A one-entry cache avoids recompiling a document-supplied pattern per node
// without retaining an attacker-controlled set of patterns.
/** @type {string | undefined} */
let reLast;
/** @type {any} */
let reNfa;
/**
 * @param {any} s
 * @param {any} p
 * @param {boolean} [full]
 * @returns {boolean}
 */
let reTest = (s, p, full) => {
  if (typeof s !== "string" || typeof p !== "string") return false;
  if (p.length > 8192) return false;
  try {
    if (p !== reLast) {
      reLast = p;
      reNfa = null;
      reNfa = compileRE(p, { anchors: true });
    }
    return reNfa.code ? false : full ? reNfa.match(s) : reNfa.search(s);
  } catch (e) {
    if (!isREDiagnostic(e)) throw e;
    // oxlint-disable-next-line no-unused-expressions
    reNfa || (reNfa = e);
    return false;
  }
};

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
  return { value: value, depth: depth };
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
let put = (out, obj, key, depth, ctx) => {
  const x = edge(obj, key, depth, ctx);
  if (x) out.push(x);
};

/**
 * @param {Loc} node
 * @param {Ctx} ctx
 * @returns {Loc[]}
 */
let kids = (node, ctx) => {
  const value = node.value,
    depth = node.depth + 1,
    out = /** @type {Loc[]} */ ([]);
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) for (let j = 0; j < value.length; j++) put(out, value, j, depth, ctx);
  else for (const k of Object.keys(value)) if (!BLOCK(k)) put(out, value, k, depth, ctx);
  return out;
};

// Node plus all descendants, depth-first. Raw objects on the stack are exit
// markers, keeping cycle detection scoped to the active ancestor path.
/**
 * @param {Loc} node
 * @param {Ctx} ctx
 * @returns {Loc[]}
 */
let all = (node, ctx) => {
  const out = /** @type {Loc[]} */ ([]),
    stack = /** @type {any[]} */ ([node]),
    seen = new Set();
  while (stack.length) {
    node = stack.pop();
    if (seen.delete(node)) continue;
    const n = node.value;
    if (n && typeof n === "object") {
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(n);
    }
    out.push(node);
    const children = kids(node, ctx);
    while (children.length) stack.push(children.pop());
  }
  return out;
};

/**
 * @param {Loc} node
 * @param {any} key
 * @param {Ctx} ctx
 * @returns {Loc[]}
 */
let child = (node, key, ctx) => {
  const n = node.value;
  if (n == null || typeof n !== "object" || BLOCK(key)) return [];
  if (Array.isArray(n)) {
    key = +key;
    if (key < 0) key += n.length;
    if (!Number.isInteger(key) || key < 0 || key >= n.length) return [];
  }
  const v = edge(n, key, node.depth + 1, ctx);
  return v ? [v] : [];
};

// RFC 9535 quoted string → value. Escaped quotes must match the delimiter,
// and the decoded value must contain only Unicode scalar values.
/**
 * @param {string} raw
 * @returns {string}
 */
let unq = (raw) => {
  const q = raw[0],
    end = raw.length - 1;
  let out = "";
  /** @type {() => never} */
  const bad = () => err("Invalid string literal");
  for (let j = 1; j < end; j++) {
    let c = raw[j];
    if (c === "\\") {
      c = raw[++j];
      if (c === q) out += c;
      else if ("bfnrt/\\".includes(c))
        out += { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[c] ?? c;
      else if (c === "u" && /^[\da-f]{4}$/i.test(raw.slice(j + 1, j + 5))) {
        const a = parseInt(raw.slice(j + 1, j + 5), 16);
        j += 4;
        if (a >= 0xd800 && a <= 0xdbff) {
          // oxlint-disable-next-line no-unused-expressions
          (raw.slice(j + 1, j + 3) === "\\u" && /^[\da-f]{4}$/i.test(raw.slice(j + 3, j + 7))) ||
            bad();
          const b = parseInt(raw.slice(j + 3, j + 7), 16);
          // oxlint-disable-next-line no-unused-expressions
          (b >= 0xdc00 && b <= 0xdfff) || bad();
          out += String.fromCharCode(a, b);
          j += 6;
        } else {
          // oxlint-disable-next-line no-unused-expressions
          a < 0xdc00 || a > 0xdfff || bad();
          out += String.fromCharCode(a);
        }
      } else bad();
    } else {
      // oxlint-disable-next-line no-unused-expressions
      (c >= " " && c !== q) || bad();
      // The explicit 0 is `charCodeAt`'s own default, which its lib signature requires.
      const a = c.charCodeAt(0);
      if (a >= 0xd800 && a <= 0xdbff) {
        const b = raw.charCodeAt(j + 1);
        // oxlint-disable-next-line no-unused-expressions
        (b >= 0xdc00 && b <= 0xdfff) || bad();
        out += c + raw[++j];
      } else {
        // oxlint-disable-next-line no-unused-expressions
        a < 0xdc00 || a > 0xdfff || bad();
        out += c;
      }
    }
  }
  return out;
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
  for (; from < text.length; from++) {
    const c = text[from];
    if (q) {
      if (c === "\\") from++;
      else if (c === q) q = 0;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "(") d++;
    else if (c === "]" || c === ")") {
      if (!--d) return c === "]" ? from : err("Missing ] in path");
    }
  }
  err("Missing ] in path");
};

// Split `[...]` contents on top-level commas (unions).
/**
 * @param {string} text
 * @returns {string[]}
 */
let split = (text) => {
  const out = /** @type {string[]} */ ([]);
  let d = 0,
    /** @type {string | 0} */ q = 0,
    start = 0;
  for (let j = 0; j < text.length; j++) {
    const c = text[j];
    if (q) {
      if (c === "\\") j++;
      else if (c === q) q = 0;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "(") d++;
    else if (c === "]" || c === ")") d--;
    else if (c === "," && !d) {
      out.push(text.slice(start, j));
      start = j + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((x) => x.trim());
};

// One selector inside `[...]` → executor plus dependency-topology tuple.
/**
 * @param {string} spec
 * @param {Record<string, Function>} fns
 * @param {any} meta
 * @returns {Sel}
 */
let selector = (spec, fns, meta) => {
  if (spec === "*") return { run: (n, root, ctx) => kids(n, ctx), topology: ["wildcard"] };
  if (spec[0] === "?") {
    // `?expr` and the classic `?(expr)` both parse: parentheses are ordinary
    // grouping in the filter grammar, so no unwrapping is needed.
    const test = rfcFilter(spec.slice(1), fns, meta);
    return {
      run: (n, root, ctx) => kids(n, ctx).filter((c) => test(c.value, root, ctx)),
      topology: ["filter"],
    };
  }
  const sliceMatch = /^(-?\d*)\s*:\s*(-?\d*)(?:\s*:\s*(-?\d+)?)?$/.exec(spec);
  if (sliceMatch) {
    // RFC 9535 slice: negative indexes count from the end, negative steps
    // walk backwards, step 0 selects nothing.
    const st = sliceMatch[3] ? +sliceMatch[3] : 1;
    return {
      topology: [
        "slice",
        sliceMatch[1] ? +sliceMatch[1] : null,
        sliceMatch[2] ? +sliceMatch[2] : null,
        st,
      ],
      run: (n, root, ctx) => {
        if (!Array.isArray(n.value) || !st) return [];
        const len = n.value.length,
          norm = (/** @type {number} */ x) => (x < 0 ? x + len : x),
          out = /** @type {Loc[]} */ ([]);
        if (st > 0) {
          const lo = Math.min(Math.max(sliceMatch[1] ? norm(+sliceMatch[1]) : 0, 0), len);
          const hi = Math.min(Math.max(sliceMatch[2] ? norm(+sliceMatch[2]) : len, 0), len);
          for (let j = lo; j < hi; j += st) put(out, n.value, j, n.depth + 1, ctx);
        } else {
          const hi = Math.min(
            Math.max(sliceMatch[1] ? norm(+sliceMatch[1]) : len - 1, -1),
            len - 1,
          );
          const lo = Math.min(Math.max(sliceMatch[2] ? norm(+sliceMatch[2]) : -1, -1), len - 1);
          for (let j = hi; j > lo; j += st) put(out, n.value, j, n.depth + 1, ctx);
        }
        return out;
      },
    };
  }
  const q = /^(['"])([\s\S]*)\1$/.exec(spec);
  // RFC 9535 typing: a quoted name selects only from objects, an index only
  // from arrays.
  if (q) {
    const k = unq(spec);
    return {
      run: (n, root, ctx) => (Array.isArray(n.value) ? [] : child(n, k, ctx)),
      topology: ["name", k],
    };
  }
  if (/^-?\d+$/.test(spec))
    return {
      run: (n, root, ctx) => (Array.isArray(n.value) ? child(n, spec, ctx) : []),
      topology: ["index", +spec || 0],
    };
  // `return` so the never from err() lands in the signature: without it every
  // caller sees `| undefined` and has to null-check a selector that cannot be.
  return err("Bad selector [" + spec + "]");
};

// Parse consecutive segments starting at index `j`; returns the compiled
// segments plus where parsing stopped. Top level (`soft` false) errors on any
// unexpected character. Soft mode instead stops at the first character that
// cannot start a segment, so embedded queries inside filters can end
// mid-string (before an operator, `)`, `]`, or `,`).
/**
 * @param {string} path
 * @param {number} j
 * @param {Record<string, Function>} fns
 * @param {boolean} soft
 * @param {any} meta
 * @param {any[]} dep
 * @returns {{ segs: Seg[], j: number }}
 */
let segments = (path, j, fns, soft, meta, dep) => {
  const segs = /** @type {Seg[]} */ ([]);
  while (j < path.length) {
    const back = j;
    // Whitespace is allowed before a segment, never inside one.
    while (/\s/.test(path[j])) j++;
    let desc = false;
    if (path.startsWith("..", j)) {
      desc = true;
      j += 2;
    } else if (path[j] === ".") j++;
    else if (path[j] !== "[") {
      if (soft) return { segs, j: back };
      err('Unexpected "' + path[j] + '" in path');
    }
    if (path[j] === "[") {
      const end = close(path, j);
      const raw = split(path.slice(j + 1, end));
      const sels = raw.map((s) => selector(s, fns, meta));
      let m = raw.length === 1 ? sels[0].topology : ["union", ...sels.map((s) => s.topology)];
      dep.push(desc ? ["descendant", m] : m);
      // Singular per RFC 9535: one selector, and it is a name or index.
      const sing = !desc && raw.length === 1 && (/^-?\d+$/.test(raw[0]) || /^["']/.test(raw[0]));
      // Node-major order (RFC 9535): all selectors run per node before
      // moving to the next node.
      segs.push({
        d: desc,
        s: sing,
        f: (ns, root, ctx) => ns.flatMap((n) => sels.flatMap((sel) => sel.run(n, root, ctx))),
      });
      j = end + 1;
    } else {
      const m =
        /^(\*|[A-Za-z_\u{80}-\u{10FFFF}][\w\u{80}-\u{10FFFF}]*)/u.exec(path.slice(j)) ||
        err("Bad path near index " + j);
      j += m[1].length;
      const k = m[1];
      const x = k === "*" ? ["wildcard"] : ["name", k];
      dep.push(desc ? ["descendant", x] : x);
      segs.push({
        d: desc,
        s: !desc && k !== "*",
        f:
          k === "*"
            ? (ns, root, ctx) => ns.flatMap((n) => kids(n, ctx))
            : (ns, root, ctx) => ns.flatMap((n) => child(n, k, ctx)),
      });
    }
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
let run = (segs, start, root, ctx) => {
  let nodes = [loc(start, 0, ctx)];
  nodes = segs.reduce(
    (acc, s) => s.f(s.d ? acc.flatMap((n) => all(n, ctx)) : acc, root, ctx),
    nodes,
  );
  limit(ctx, 2, nodes.length);
  return nodes;
};

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
 * @param {any} left
 * @param {any} right
 * @returns {boolean}
 */
let deepEq = (left, right) => {
  const stack = /** @type {any[]} */ ([left, right]);
  let steps = 0;
  while (stack.length) {
    if (++steps > EQ_STEPS) cap("maxComparisons", "PADVINDER_MAX_COMPARISONS", EQ_STEPS, steps);
    const y = stack.pop(),
      x = stack.pop();
    if (x === y) continue;
    // Arrays and objects share one own-key walk: array elements are index
    // keys, and the extra `length` comparison pins the element count
    // (undefined === undefined for plain objects, so it never rejects them).
    if (
      x &&
      y &&
      typeof x === "object" &&
      typeof y === "object" &&
      Array.isArray(x) === Array.isArray(y)
    ) {
      const keysLeft = Object.keys(x).filter((k) => !BLOCK(k)),
        keysRight = Object.keys(y).filter((k) => !BLOCK(k));
      if (keysLeft.length !== keysRight.length || x.length !== y.length) return false;
      for (const k of keysLeft) {
        if (!Object.hasOwn(y, k)) return false;
        stack.push(x[k], y[k]);
      }
    } else return false;
  }
  return true;
};

// RFC comparison semantics: == is deep, Nothing only equals Nothing, and the
// orderings apply to two numbers or two strings, nothing else.
/**
 * @param {string} op
 * @param {any} left
 * @param {any} right
 * @returns {boolean}
 */
let cmp = (op, left, right) =>
  op === "=="
    ? left === NOTHING || right === NOTHING
      ? left === right
      : deepEq(left, right)
    : op === "!="
      ? !cmp("==", left, right)
      : op === "<="
        ? cmp("==", left, right) || cmp("<", left, right)
        : op === ">="
          ? cmp("==", left, right) || cmp("<", right, left)
          : op === ">"
            ? cmp("<", right, left)
            : typeof left === typeof right &&
              (typeof left === "number" || typeof left === "string") &&
              left < right; // <

// The five built-in RFC function extensions with their argument and return
// types. A name absent here is looked up in the caller's registry instead.
/** @type {Record<string, { a: string[], r: string, f: (args: Arg[]) => Arg }>} */
const RFCFN = {
  length: {
    a: ["value"],
    r: "value",
    f:
      ([a]) =>
      (n, r, ctx) => {
        const v = a(n, r, ctx);
        return typeof v === "string"
          ? [...v].length
          : Array.isArray(v)
            ? v.length
            : v && typeof v === "object"
              ? Object.keys(v).length
              : NOTHING;
      },
  },
  count: {
    a: ["nodes"],
    r: "value",
    f:
      ([a]) =>
      (n, r, ctx) =>
        a(n, r, ctx).length,
  },
  value: {
    a: ["nodes"],
    r: "value",
    f:
      ([a]) =>
      (n, r, ctx) => {
        const ns = a(n, r, ctx);
        return ns.length === 1 ? ns[0] : NOTHING;
      },
  },
  match: {
    a: ["value", "value"],
    r: "logical",
    f:
      ([a, b]) =>
      (n, r, ctx) =>
        reTest(a(n, r, ctx), b(n, r, ctx), true),
  },
  search: {
    a: ["value", "value"],
    r: "logical",
    f:
      ([a, b]) =>
      (n, r, ctx) =>
        reTest(a(n, r, ctx), b(n, r, ctx), false),
  },
};

// Parse one filter body as the RFC grammar, producing (node, root) => boolean.
// Throws SyntaxError on anything that is not valid RFC 9535 filter syntax.
/**
 * @param {string} source
 * @param {Record<string, Function>} fns
 * @param {any} meta
 * @returns {Test}
 */
let rfcFilter = (source, fns, meta) => {
  let k = 0;
  /** @type {() => never} */
  const fail = () => err("Bad filter: " + source);
  const ws = () => {
    while (/\s/.test(source[k])) k++;
  };
  /** @param {string} c */
  const eat = (c) => source.startsWith(c, k) && ((k += c.length), !0);

  // `@` or `$` plus segments; runs to a nodelist.
  /** @returns {{ s: boolean, f: (n: any, r: any, ctx: Ctx) => Loc[] }} */
  const queryExpr = () => {
    const abs = source[k++] === "$";
    const dep = [abs ? "$" : "@"];
    meta.p.push(dep);
    const { segs, j } = segments(source, k, fns, !0, meta, dep);
    k = j;
    return {
      s: segs.every((s) => s.s),
      f: (n, r, ctx) => run(segs, abs ? r : n, r, ctx),
    };
  };

  // Literal number, string, or keyword; undefined when none matches.
  /** @returns {Arg | undefined} */
  const literal = () => {
    const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(k));
    if (m && !/[\w.]/.test(source[k + m[0].length] ?? "")) {
      k += m[0].length;
      const v = +m[0];
      return () => v;
    }
    if (source[k] === '"' || source[k] === "'") {
      let j = k + 1;
      for (; j < source.length && source[j] !== source[k]; j++) if (source[j] === "\\") j++;
      // oxlint-disable-next-line no-unused-expressions
      j < source.length || fail();
      const v = unq(source.slice(k, j + 1));
      k = j + 1;
      return () => v;
    }
    for (const [w, v] of /** @type {[string, boolean | null][]} */ ([
      ["true", !0],
      ["false", !1],
      ["null", null],
    ]))
      if (source.startsWith(w, k) && !/\w/.test(source[k + w.length] ?? "")) {
        k += w.length;
        return () => v;
      }
  };

  // name(args) with RFC typing; `arg` parses one argument of the given type.
  /**
   * @param {string} type
   * @returns {Arg}
   */
  const arg = (type) => {
    ws();
    if (source[k] === "@" || source[k] === "$") {
      const query = queryExpr();
      if (type === "nodes") return (n, r, ctx) => query.f(n, r, ctx).map((x) => x.value);
      // oxlint-disable-next-line no-unused-expressions
      query.s || fail();
      return (n, r, ctx) => {
        const ns = query.f(n, r, ctx);
        return ns.length ? ns[0].value : NOTHING;
      };
    }
    // oxlint-disable-next-line no-unused-expressions
    type === "nodes" && fail();
    const lit = literal();
    if (lit) return lit;
    const f = funcExpr();
    // oxlint-disable-next-line no-unused-expressions
    f.t === "value" || fail();
    return f.f;
  };
  /** @returns {{ t: string, f: Arg }} */
  const funcExpr = () => {
    const m = /^[a-z][a-z0-9_]*/.exec(source.slice(k)) || fail();
    k += m[0].length;
    ws();
    // oxlint-disable-next-line no-unused-expressions
    eat("(") || fail();
    // Own-property lookup only: a name like `constructor` must not resolve
    // to an inherited Object.prototype member.
    const spec = Object.hasOwn(RFCFN, m[0]) ? RFCFN[m[0]] : undefined;
    if (spec) {
      // oxlint reports `x` as unused, but `x && (…)` reads it — it appears to
      // miss uses inside a sequence expression. `x` is the argument index, and
      // skipping the separator before the first one is exactly its job.
      // oxlint-disable-next-line no-unused-vars
      const args = spec.a.map((t, x) => (x && (ws(), eat(",") || fail()), arg(t)));
      ws();
      // oxlint-disable-next-line no-unused-expressions
      eat(")") || fail();
      return { t: spec.r, f: spec.f(args) };
    }
    // Registered function extension: value-type args, and its result may be
    // used as a value or (unlike the built-ins) as a truthiness test.
    // oxlint-disable-next-line no-unused-expressions
    Object.hasOwn(fns, m[0]) || err(m[0] + " is not a function");
    // oxlint-disable-next-line no-unused-expressions
    meta.f.includes(m[0]) || meta.f.push(m[0]);
    const f = fns[m[0]],
      args = /** @type {Arg[]} */ ([]);
    ws();
    if (!eat(")")) {
      do args.push(arg("value"));
      while ((ws(), eat(",")));
      ws();
      // oxlint-disable-next-line no-unused-expressions
      eat(")") || fail();
    }
    return { t: "user", f: (n, r, ctx) => f(...args.map((a) => a(n, r, ctx))) };
  };

  // A comparable/test primary: query, literal, or function call.
  /** @returns {Prim} */
  const primary = () => {
    ws();
    if (source[k] === "@" || source[k] === "$") return { q: queryExpr() };
    const lit = literal();
    if (lit) return { v: lit };
    const f = funcExpr();
    return f.t === "logical" ? { l: f.f } : f.t === "user" ? { v: f.f, u: !0 } : { v: f.f };
  };
  // ValueType position: literals, value functions, and singular queries only.
  /**
   * @param {Prim} prim
   * @returns {Arg}
   */
  const asValue = (prim) => {
    if (prim.v) return prim.v;
    // oxlint-disable-next-line no-unused-expressions
    (prim.q && prim.q.s) || fail();
    const q = /** @type {NonNullable<Prim['q']>} */ (prim.q);
    return (n, r, ctx) => {
      const ns = q.f(n, r, ctx);
      return ns.length ? ns[0].value : NOTHING;
    };
  };

  /** @returns {Arg} */
  const basic = () => {
    ws();
    let neg = !1;
    while (eat("!")) {
      neg = !neg;
      ws();
    }
    if (eat("(")) {
      const e = or();
      ws();
      // oxlint-disable-next-line no-unused-expressions
      eat(")") || fail();
      return neg ? (n, r, ctx) => !e(n, r, ctx) : e;
    }
    const p = primary();
    ws();
    const op = ["==", "!=", "<=", ">=", "<", ">"].find((o) => source.startsWith(o, k));
    if (op) {
      // oxlint-disable-next-line no-unused-expressions
      neg && fail();
      k += op.length;
      const a = asValue(p),
        b = asValue(primary());
      return (n, r, ctx) => cmp(op, a(n, r, ctx), b(n, r, ctx));
    }
    // Test position: a query is an existence test, a logical function is
    // itself, a registered function is truthiness-tested; a bare literal or
    // a built-in value function is not a valid test.
    // The outer cast types the whole ternary. An inner cast on the arrow used to
    // sit here too, but oxfmt strips the parentheses a JSDoc cast depends on:
    // `/** @type {T} */ ((a) => …)` becomes `/** @type {T} */ (a) => …`, where
    // the comment precedes a parameter list rather than a parenthesised
    // expression and is silently inert. Do not add an inline cast to an arrow.
    const t = /** @type {Arg} */ (
      p.q
        ? (
            (q) => (n, r, ctx) =>
              q.f(n, r, ctx).length > 0
          )(p.q)
        : p.u
          ? p.v
          : p.l || fail()
    );
    return neg ? (n, r, ctx) => !t(n, r, ctx) : t;
  };
  /** @returns {Arg} */
  const and = () => {
    let l = basic();
    for (ws(); eat("&&"); ws()) {
      const a = l,
        b = basic();
      l = (n, r, ctx) => a(n, r, ctx) && b(n, r, ctx);
    }
    return l;
  };
  /** @returns {Arg} */
  const or = () => {
    let l = and();
    for (ws(); eat("||"); ws()) {
      const a = l,
        b = and();
      l = (n, r, ctx) => a(n, r, ctx) || b(n, r, ctx);
    }
    return l;
  };

  const e = or();
  ws();
  // oxlint-disable-next-line no-unused-expressions
  k === source.length || fail();
  return e;
};

/**
 * @template T
 * @param {T} x
 * @returns {T}
 */
let freeze = (x) => {
  if (Array.isArray(x)) x.forEach(freeze);
  return Object.freeze(x);
};
/** @param {any[]} xs */
let unique = (xs) =>
  freeze(
    [...new Map(xs.map((x) => /** @type {[string, any]} */ ([JSON.stringify(x), x]))).values()].map(
      freeze,
    ),
  );

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
  if (options != null && (typeof options !== "object" || Array.isArray(options)))
    throw fault(TypeError, "options must be an object");
  options = options || {};
  // The budget names are iterated dynamically, so the option bag is read as a
  // lookup table here; `QueryOptions` stays the published shape.
  const opts = /** @type {Record<string, any>} */ (options);
  for (const k of Object.keys(options))
    if (!LIMITS.includes(k)) throw fault(TypeError, 'Unknown option "' + k + '"');
  for (const k of LIMITS)
    if (Object.hasOwn(options, k)) {
      if (typeof opts[k] !== "number") throw fault(TypeError, k + " must be a number");
      if (!Number.isSafeInteger(opts[k]) || opts[k] < 0)
        throw fault(RangeError, k + " must be a non-negative safe integer");
    }
  path = String(path).trim();
  // oxlint-disable-next-line no-unused-expressions
  path[0] === "$" || err("Path must start with $");
  const meta = { p: /** @type {any[]} */ ([["$"]]), f: /** @type {string[]} */ ([]) };
  const { segs } = segments(path, 1, funcs, false, meta, meta.p[0]);
  const limits = LIMITS.map((k) => opts[k]),
    budget = limits.some((x) => x !== undefined);
  const own = {};
  const runner = (/** @type {any} */ data) => {
    const ctx = budget ? [...limits, 0, own] : null;
    return run(segs, data, data, ctx).map((x) => x.value);
  };
  runner.paths = unique(meta.p);
  runner.functions = freeze(meta.f);
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
