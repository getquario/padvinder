/**
 * Tiny, CSP-safe RFC 9535 JSONPath engine.
 * Paths and filters compile to a composition of closures; query text is
 * never turned into JavaScript, so strict CSP is satisfied.
 */

import { compile as compileRE, isDiagnostic as isREDiagnostic } from 'treffer';

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
 * @typedef {{ v: any, d: number }} Loc
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
 * One compiled selector: `f` executes it against a node, `m` is the
 * dependency-topology tuple published through `runner.paths`.
 *
 * @internal
 * @typedef {{ f: (n: Loc, root: any, ctx: Ctx) => Loc[], m: any[] }} Sel
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
const BLOCK = k => k === '__proto__' || k === 'constructor' || k === 'prototype';
const LIMITS = ['maxNodes', 'maxDepth', 'maxResults'];
// Positionally parallel to LIMITS. Kept as literals so tsc checks them against
// PadvinderErrorCode at the `cap()` call site.
/** @type {PadvinderErrorCode[]} */
const CODES = ['PADVINDER_MAX_NODES', 'PADVINDER_MAX_DEPTH', 'PADVINDER_MAX_RESULTS'];

let diags = new WeakMap(), mark = diags.set.bind(diags), origin = diags.get.bind(diags);
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
	return mark(e, own), e;
};
/** @type {(m: string) => never} */
const err = m => { throw fault(SyntaxError, m) };

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
	if (typeof s !== 'string' || typeof p !== 'string') return false;
	if (p.length > 8192) return false;
	try {
		if (p !== reLast) { reLast = p; reNfa = null; reNfa = compileRE(p, { anchors: true }) }
		return reNfa.code ? false : full ? reNfa.match(s) : reNfa.search(s);
	} catch (e) {
		if (!isREDiagnostic(e)) throw e;
		reNfa || (reNfa = e); // oxlint-disable-line no-unused-expressions
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
	const e = /** @type {Error & { code: PadvinderErrorCode, limit: number, actual: number }} */ (fault(RangeError, name + ' limit of ' + max + ' exceeded', own));
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
	return { v: value, d: depth };
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
 * @param {Loc} x
 * @param {Ctx} ctx
 * @returns {Loc[]}
 */
let kids = (x, ctx) => {
	const n = x.v, depth = x.d + 1, out = /** @type {Loc[]} */ ([]);
	if (!n || typeof n !== 'object') return out;
	if (Array.isArray(n)) for (let j = 0; j < n.length; j++) put(out, n, j, depth, ctx);
	else for (const k of Object.keys(n)) if (!BLOCK(k)) put(out, n, k, depth, ctx);
	return out;
};

// Node plus all descendants, depth-first. Raw objects on the stack are exit
// markers, keeping cycle detection scoped to the active ancestor path.
/**
 * @param {Loc} x
 * @param {Ctx} ctx
 * @returns {Loc[]}
 */
let all = (x, ctx) => {
	const out = /** @type {Loc[]} */ ([]), stack = /** @type {any[]} */ ([x]), seen = new Set();
	while (stack.length) {
		x = stack.pop();
		if (seen.delete(x)) continue;
		const n = x.v;
		if (n && typeof n === 'object') {
			if (seen.has(n)) continue;
			seen.add(n);
			stack.push(n);
		}
		out.push(x);
		const cs = kids(x, ctx);
		while (cs.length) stack.push(cs.pop());
	}
	return out;
};

/**
 * @param {Loc} x
 * @param {any} k
 * @param {Ctx} ctx
 * @returns {Loc[]}
 */
let child = (x, k, ctx) => {
	const n = x.v;
	if (n == null || typeof n !== 'object' || BLOCK(k)) return [];
	if (Array.isArray(n)) {
		k = +k;
		if (k < 0) k += n.length;
		if (!Number.isInteger(k) || k < 0 || k >= n.length) return [];
	}
	const v = edge(n, k, x.d + 1, ctx);
	return v ? [v] : [];
};

// RFC 9535 quoted string → value. Escaped quotes must match the delimiter,
// and the decoded value must contain only Unicode scalar values.
/**
 * @param {string} s
 * @returns {string}
 */
let unq = s => {
	const q = s[0], end = s.length - 1;
	let out = '';
	/** @type {() => never} */
	const bad = () => err('Invalid string literal');
	for (let j = 1; j < end; j++) {
		let c = s[j];
		if (c === '\\') {
			c = s[++j];
			if (c === q) out += c;
			else if ('bfnrt/\\'.includes(c)) out += { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[c] ?? c;
			else if (c === 'u' && /^[\da-f]{4}$/i.test(s.slice(j + 1, j + 5))) {
				const a = parseInt(s.slice(j + 1, j + 5), 16);
				j += 4;
				if (a >= 0xd800 && a <= 0xdbff) {
					(s.slice(j + 1, j + 3) === '\\u' && /^[\da-f]{4}$/i.test(s.slice(j + 3, j + 7))) || bad(); // oxlint-disable-line no-unused-expressions
					const b = parseInt(s.slice(j + 3, j + 7), 16);
					(b >= 0xdc00 && b <= 0xdfff) || bad(); // oxlint-disable-line no-unused-expressions
					out += String.fromCharCode(a, b);
					j += 6;
				} else {
					(a < 0xdc00 || a > 0xdfff) || bad(); // oxlint-disable-line no-unused-expressions
					out += String.fromCharCode(a);
				}
			} else bad();
		} else {
			(c >= ' ' && c !== q) || bad(); // oxlint-disable-line no-unused-expressions
			// The explicit 0 is `charCodeAt`'s own default, which its lib signature requires.
			const a = c.charCodeAt(0);
			if (a >= 0xd800 && a <= 0xdbff) {
				const b = s.charCodeAt(j + 1);
				(b >= 0xdc00 && b <= 0xdfff) || bad(); // oxlint-disable-line no-unused-expressions
				out += c + s[++j];
			} else {
				(a < 0xdc00 || a > 0xdfff) || bad(); // oxlint-disable-line no-unused-expressions
				out += c;
			}
		}
	}
	return out;
};

// Index of the `]` matching the `[` at s[j], respecting nesting and strings.
/**
 * @param {string} s
 * @param {number} j
 * @returns {number}
 */
let close = (s, j) => {
	let d = 0, /** @type {string | 0} */ q = 0;
	for (; j < s.length; j++) {
		const c = s[j];
		if (q) { if (c === '\\') j++; else if (c === q) q = 0; }
		else if (c === '"' || c === "'") q = c;
		else if (c === '[' || c === '(') d++;
		else if (c === ']' || c === ')') { if (!--d) return c === ']' ? j : err('Missing ] in path'); }
	}
	err('Missing ] in path');
};

// Split `[...]` contents on top-level commas (unions).
/**
 * @param {string} s
 * @returns {string[]}
 */
let split = s => {
	const out = /** @type {string[]} */ ([]);
	let d = 0, /** @type {string | 0} */ q = 0, start = 0;
	for (let j = 0; j < s.length; j++) {
		const c = s[j];
		if (q) { if (c === '\\') j++; else if (c === q) q = 0; }
		else if (c === '"' || c === "'") q = c;
		else if (c === '[' || c === '(') d++;
		else if (c === ']' || c === ')') d--;
		else if (c === ',' && !d) { out.push(s.slice(start, j)); start = j + 1; }
	}
	out.push(s.slice(start));
	return out.map(x => x.trim());
};

// One selector inside `[...]` → executor plus dependency-topology tuple.
/**
 * @param {string} s
 * @param {Record<string, Function>} fns
 * @param {any} meta
 * @returns {Sel}
 */
let selector = (s, fns, meta) => {
	if (s === '*') return { f: (n, root, ctx) => kids(n, ctx), m: ['wildcard'] };
	if (s[0] === '?') {
		// `?expr` and the classic `?(expr)` both parse: parentheses are ordinary
		// grouping in the filter grammar, so no unwrapping is needed.
		const test = rfcFilter(s.slice(1), fns, meta);
		return { f: (n, root, ctx) => kids(n, ctx).filter(c => test(c.v, root, ctx)), m: ['filter'] };
	}
	const sl = /^(-?\d*)\s*:\s*(-?\d*)(?:\s*:\s*(-?\d+)?)?$/.exec(s);
	if (sl) {
		// RFC 9535 slice: negative indexes count from the end, negative steps
		// walk backwards, step 0 selects nothing.
		const st = sl[3] ? +sl[3] : 1;
		return { m: ['slice', sl[1] ? +sl[1] : null, sl[2] ? +sl[2] : null, st], f: (n, root, ctx) => {
			if (!Array.isArray(n.v) || !st) return [];
			const len = n.v.length, norm = (/** @type {number} */ x) => (x < 0 ? x + len : x), out = /** @type {Loc[]} */ ([]);
			if (st > 0) {
				const lo = Math.min(Math.max(sl[1] ? norm(+sl[1]) : 0, 0), len);
				const hi = Math.min(Math.max(sl[2] ? norm(+sl[2]) : len, 0), len);
				for (let j = lo; j < hi; j += st) put(out, n.v, j, n.d + 1, ctx);
			} else {
				const hi = Math.min(Math.max(sl[1] ? norm(+sl[1]) : len - 1, -1), len - 1);
				const lo = Math.min(Math.max(sl[2] ? norm(+sl[2]) : -1, -1), len - 1);
				for (let j = hi; j > lo; j += st) put(out, n.v, j, n.d + 1, ctx);
			}
			return out;
		} };
	}
	const q = /^(['"])([\s\S]*)\1$/.exec(s);
	// RFC 9535 typing: a quoted name selects only from objects, an index only
	// from arrays.
	if (q) {
		const k = unq(s);
		return { f: (n, root, ctx) => Array.isArray(n.v) ? [] : child(n, k, ctx), m: ['name', k] };
	}
	if (/^-?\d+$/.test(s)) return { f: (n, root, ctx) => Array.isArray(n.v) ? child(n, s, ctx) : [], m: ['index', +s || 0] };
	// `return` so the never from err() lands in the signature: without it every
	// caller sees `| undefined` and has to null-check a selector that cannot be.
	return err('Bad selector [' + s + ']');
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
		if (path.startsWith('..', j)) { desc = true; j += 2; }
		else if (path[j] === '.') j++;
		else if (path[j] !== '[') {
			if (soft) return { segs, j: back };
			err('Unexpected "' + path[j] + '" in path');
		}
		if (path[j] === '[') {
			const end = close(path, j);
			const raw = split(path.slice(j + 1, end));
			const sels = raw.map(s => selector(s, fns, meta));
			let m = raw.length === 1 ? sels[0].m : ['union', ...sels.map(s => s.m)];
			dep.push(desc ? ['descendant', m] : m);
			// Singular per RFC 9535: one selector, and it is a name or index.
			const sing = !desc && raw.length === 1 && (/^-?\d+$/.test(raw[0]) || /^["']/.test(raw[0]));
			// Node-major order (RFC 9535): all selectors run per node before
			// moving to the next node.
			segs.push({ d: desc, s: sing, f: (ns, root, ctx) => ns.flatMap(n => sels.flatMap(sel => sel.f(n, root, ctx))) });
			j = end + 1;
		} else {
			const m = /^(\*|[A-Za-z_\u{80}-\u{10FFFF}][\w\u{80}-\u{10FFFF}]*)/u.exec(path.slice(j)) || err('Bad path near index ' + j);
			j += m[1].length;
			const k = m[1];
			const x = k === '*' ? ['wildcard'] : ['name', k];
			dep.push(desc ? ['descendant', x] : x);
			segs.push({ d: desc, s: !desc && k !== '*', f: k === '*' ? (ns, root, ctx) => ns.flatMap(n => kids(n, ctx)) : (ns, root, ctx) => ns.flatMap(n => child(n, k, ctx)) });
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
	let ns = [loc(start, 0, ctx)];
	ns = segs.reduce((acc, s) => s.f(s.d ? acc.flatMap(n => all(n, ctx)) : acc, root, ctx), ns);
	limit(ctx, 2, ns.length);
	return ns;
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
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
let deepEq = (a, b) => {
	const stack = /** @type {any[]} */ ([a, b]);
	let steps = 0;
	while (stack.length) {
		if (++steps > EQ_STEPS) cap('maxComparisons', 'PADVINDER_MAX_COMPARISONS', EQ_STEPS, steps);
		const y = stack.pop(), x = stack.pop();
		if (x === y) continue;
		// Arrays and objects share one own-key walk: array elements are index
		// keys, and the extra `length` comparison pins the element count
		// (undefined === undefined for plain objects, so it never rejects them).
		if (x && y && typeof x === 'object' && typeof y === 'object' && Array.isArray(x) === Array.isArray(y)) {
			const kx = Object.keys(x).filter(k => !BLOCK(k)), ky = Object.keys(y).filter(k => !BLOCK(k));
			if (kx.length !== ky.length || x.length !== y.length) return false;
			for (const k of kx) {
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
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
let cmp = (op, a, b) =>
	op === '==' ? (a === NOTHING || b === NOTHING ? a === b : deepEq(a, b)) :
	op === '!=' ? !cmp('==', a, b) :
	op === '<=' ? cmp('==', a, b) || cmp('<', a, b) :
	op === '>=' ? cmp('==', a, b) || cmp('<', b, a) :
	op === '>' ? cmp('<', b, a) :
	(typeof a === typeof b && (typeof a === 'number' || typeof a === 'string') && a < b); // <

// The five built-in RFC function extensions with their argument and return
// types. A name absent here is looked up in the caller's registry instead.
/** @type {Record<string, { a: string[], r: string, f: (args: Arg[]) => Arg }>} */
const RFCFN = {
	length: { a: ['value'], r: 'value', f: ([a]) => (n, r, ctx) => {
		const v = a(n, r, ctx);
		return typeof v === 'string' ? [...v].length
			: Array.isArray(v) ? v.length
			: v && typeof v === 'object' ? Object.keys(v).length
			: NOTHING;
	} },
	count: { a: ['nodes'], r: 'value', f: ([a]) => (n, r, ctx) => a(n, r, ctx).length },
	value: { a: ['nodes'], r: 'value', f: ([a]) => (n, r, ctx) => {
		const ns = a(n, r, ctx);
		return ns.length === 1 ? ns[0] : NOTHING;
	} },
	match: { a: ['value', 'value'], r: 'logical', f: ([a, b]) => (n, r, ctx) => reTest(a(n, r, ctx), b(n, r, ctx), true) },
	search: { a: ['value', 'value'], r: 'logical', f: ([a, b]) => (n, r, ctx) => reTest(a(n, r, ctx), b(n, r, ctx), false) },
};

// Parse one filter body as the RFC grammar, producing (node, root) => boolean.
// Throws SyntaxError on anything that is not valid RFC 9535 filter syntax.
/**
 * @param {string} src
 * @param {Record<string, Function>} fns
 * @param {any} meta
 * @returns {Test}
 */
let rfcFilter = (src, fns, meta) => {
	let k = 0;
	/** @type {() => never} */
	const fail = () => err('Bad filter: ' + src);
	const ws = () => { while (/\s/.test(src[k])) k++; };
	/** @param {string} c */
	const eat = c => src.startsWith(c, k) && (k += c.length, !0);

	// `@` or `$` plus segments; runs to a nodelist.
	/** @returns {{ s: boolean, f: (n: any, r: any, ctx: Ctx) => Loc[] }} */
	const queryExpr = () => {
		const abs = src[k++] === '$';
		const dep = [abs ? '$' : '@'];
		meta.p.push(dep);
		const { segs, j } = segments(src, k, fns, !0, meta, dep);
		k = j;
		return {
			s: segs.every(s => s.s),
			f: (n, r, ctx) => run(segs, abs ? r : n, r, ctx),
		};
	};

	// Literal number, string, or keyword; undefined when none matches.
	/** @returns {Arg | undefined} */
	const literal = () => {
		const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(k));
		if (m && !/[\w.]/.test(src[k + m[0].length] ?? '')) {
			k += m[0].length;
			const v = +m[0];
			return () => v;
		}
		if (src[k] === '"' || src[k] === "'") {
			let j = k + 1;
			for (; j < src.length && src[j] !== src[k]; j++) if (src[j] === '\\') j++;
			j < src.length || fail(); // oxlint-disable-line no-unused-expressions
			const v = unq(src.slice(k, j + 1));
			k = j + 1;
			return () => v;
		}
		for (const [w, v] of /** @type {[string, boolean | null][]} */ ([['true', !0], ['false', !1], ['null', null]]))
			if (src.startsWith(w, k) && !/\w/.test(src[k + w.length] ?? '')) {
				k += w.length;
				return () => v;
			}
	};

	// name(args) with RFC typing; `arg` parses one argument of the given type.
	/**
	 * @param {string} type
	 * @returns {Arg}
	 */
	const arg = type => {
		ws();
		if (src[k] === '@' || src[k] === '$') {
			const q = queryExpr();
			if (type === 'nodes') return (n, r, ctx) => q.f(n, r, ctx).map(x => x.v);
			q.s || fail(); // oxlint-disable-line no-unused-expressions
			return (n, r, ctx) => { const ns = q.f(n, r, ctx); return ns.length ? ns[0].v : NOTHING; };
		}
		type === 'nodes' && fail(); // oxlint-disable-line no-unused-expressions
		const lit = literal();
		if (lit) return lit;
		const f = funcExpr();
		f.t === 'value' || fail(); // oxlint-disable-line no-unused-expressions
		return f.f;
	};
	/** @returns {{ t: string, f: Arg }} */
	const funcExpr = () => {
		const m = /^[a-z][a-z0-9_]*/.exec(src.slice(k)) || fail();
		k += m[0].length;
		ws(); eat('(') || fail(); // oxlint-disable-line no-unused-expressions
		// Own-property lookup only: a name like `constructor` must not resolve
		// to an inherited Object.prototype member.
		const spec = Object.hasOwn(RFCFN, m[0]) ? RFCFN[m[0]] : undefined;
		if (spec) {
			// oxlint reports `x` as unused, but `x && (…)` reads it — it appears to
			// miss uses inside a sequence expression. `x` is the argument index, and
			// skipping the separator before the first one is exactly its job.
			const args = spec.a.map((t, x) => (x && (ws(), eat(',') || fail()), arg(t))); // oxlint-disable-line no-unused-vars
			ws(); eat(')') || fail(); // oxlint-disable-line no-unused-expressions
			return { t: spec.r, f: spec.f(args) };
		}
		// Registered function extension: value-type args, and its result may be
		// used as a value or (unlike the built-ins) as a truthiness test.
		Object.hasOwn(fns, m[0]) || err(m[0] + ' is not a function'); // oxlint-disable-line no-unused-expressions
		meta.f.includes(m[0]) || meta.f.push(m[0]); // oxlint-disable-line no-unused-expressions
		const f = fns[m[0]], args = /** @type {Arg[]} */ ([]);
		ws();
		if (!eat(')')) {
			do args.push(arg('value')); while (ws(), eat(','));
			ws(); eat(')') || fail(); // oxlint-disable-line no-unused-expressions
		}
		return { t: 'user', f: (n, r, ctx) => f(...args.map(a => a(n, r, ctx))) };
	};

	// A comparable/test primary: query, literal, or function call.
	/** @returns {Prim} */
	const primary = () => {
		ws();
		if (src[k] === '@' || src[k] === '$') return { q: queryExpr() };
		const lit = literal();
		if (lit) return { v: lit };
		const f = funcExpr();
		return f.t === 'logical' ? { l: f.f } : f.t === 'user' ? { v: f.f, u: !0 } : { v: f.f };
	};
	// ValueType position: literals, value functions, and singular queries only.
	/**
	 * @param {Prim} p
	 * @returns {Arg}
	 */
	const asValue = p => {
		if (p.v) return p.v;
		p.q && p.q.s || fail(); // oxlint-disable-line no-unused-expressions
		const q = /** @type {NonNullable<Prim['q']>} */ (p.q);
		return (n, r, ctx) => { const ns = q.f(n, r, ctx); return ns.length ? ns[0].v : NOTHING; };
	};

	/** @returns {Arg} */
	const basic = () => {
		ws();
		let neg = !1;
		while (eat('!')) { neg = !neg; ws(); }
		if (eat('(')) {
			const e = or();
			ws(); eat(')') || fail(); // oxlint-disable-line no-unused-expressions
			return neg ? (n, r, ctx) => !e(n, r, ctx) : e;
		}
		const p = primary();
		ws();
		const op = ['==', '!=', '<=', '>=', '<', '>'].find(o => src.startsWith(o, k));
		if (op) {
			neg && fail(); // oxlint-disable-line no-unused-expressions
			k += op.length;
			const a = asValue(p), b = asValue(primary());
			return (n, r, ctx) => cmp(op, a(n, r, ctx), b(n, r, ctx));
		}
		// Test position: a query is an existence test, a logical function is
		// itself, a registered function is truthiness-tested; a bare literal or
		// a built-in value function is not a valid test.
		const t = /** @type {Arg} */ (p.q ? ((q => /** @type {Arg} */ ((n, r, ctx) => q.f(n, r, ctx).length > 0))(p.q)) : p.u ? p.v : (p.l || fail()));
		return neg ? (n, r, ctx) => !t(n, r, ctx) : t;
	};
	/** @returns {Arg} */
	const and = () => {
		let l = basic();
		for (ws(); eat('&&'); ws()) { const a = l, b = basic(); l = (n, r, ctx) => a(n, r, ctx) && b(n, r, ctx); }
		return l;
	};
	/** @returns {Arg} */
	const or = () => {
		let l = and();
		for (ws(); eat('||'); ws()) { const a = l, b = and(); l = (n, r, ctx) => a(n, r, ctx) || b(n, r, ctx); }
		return l;
	};

	const e = or();
	ws();
	k === src.length || fail(); // oxlint-disable-line no-unused-expressions
	return e;
};

/**
 * @template T
 * @param {T} x
 * @returns {T}
 */
let freeze = x => {
	if (Array.isArray(x)) x.forEach(freeze);
	return Object.freeze(x);
};
/** @param {any[]} xs */
let unique = xs => freeze([...new Map(xs.map(x => /** @type {[string, any]} */ ([JSON.stringify(x), x]))).values()].map(freeze));

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
	if (options != null && (typeof options !== 'object' || Array.isArray(options))) throw fault(TypeError, 'options must be an object');
	options = options || {};
	// The budget names are iterated dynamically, so the option bag is read as a
	// lookup table here; `QueryOptions` stays the published shape.
	const opts = /** @type {Record<string, any>} */ (options);
	for (const k of Object.keys(options)) if (!LIMITS.includes(k)) throw fault(TypeError, 'Unknown option "' + k + '"');
	for (const k of LIMITS) if (Object.hasOwn(options, k)) {
		if (typeof opts[k] !== 'number') throw fault(TypeError, k + ' must be a number');
		if (!Number.isSafeInteger(opts[k]) || opts[k] < 0) throw fault(RangeError, k + ' must be a non-negative safe integer');
	}
	path = String(path).trim();
	path[0] === '$' || err('Path must start with $'); // oxlint-disable-line no-unused-expressions
	const meta = { p: /** @type {any[]} */ ([['$']]), f: /** @type {string[]} */ ([]) };
	const { segs } = segments(path, 1, funcs, false, meta, meta.p[0]);
	const limits = LIMITS.map(k => opts[k]), budget = limits.some(x => x !== undefined);
	const own = {};
	const runner = (/** @type {any} */ data) => {
		const ctx = budget ? [...limits, 0, own] : null;
		return run(segs, data, data, ctx).map(x => x.v);
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
