import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { query } from '../lib/index.js';

// The official JSONPath Compliance Test Suite, vendored from
// https://github.com/jsonpath-standard/jsonpath-compliance-test-suite
// under the BSD-2 license retained in ./cts.LICENSE. Refresh both with
// `npm run cts:update`.
const cts = JSON.parse(readFileSync(new URL('./cts.json', import.meta.url)));

// Documented divergences from RFC 9535. Empty since the RFC filter grammar
// landed; the structure stays so future CTS updates that surface a new
// dialect boundary get recorded here, with a reason, instead of skipped.
// Every entry must keep failing — when a fix makes one conformant, the
// ledger check flags it so the entry gets removed.
const DIALECT = new Map();

test('compliance: valid selectors', () => {
	const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	let pass = 0, dialect = 0;
	for (const c of cts.tests) {
		if (c.invalid_selector) continue;
		let out, threw = false;
		try { out = query(c.selector)(c.document); } catch { threw = true; }
		const good = !threw && (c.results ? c.results.some(r => eq(out, r)) : eq(out, c.result));
		if (DIALECT.has(c.name)) {
			dialect++;
			if (good) assert.fail('now conformant, remove from ledger: ' + c.name);
		} else if (good) {
			pass++;
		} else {
			assert.fail(c.name + ' | ' + c.selector);
		}
	}
	assert.strictEqual(pass + dialect, cts.tests.filter(c => !c.invalid_selector).length, 'every valid case accounted for');
	assert.ok(true, pass + ' conformant, ' + dialect + ' documented divergences');
});

test('compliance: invalid selectors', () => {
	let rejected = 0, total = 0;
	for (const c of cts.tests) {
		if (!c.invalid_selector) continue;
		total++;
		try { query(c.selector); } catch { rejected++; }
	}
	// padvinder is deliberately more lenient than the RFC grammar (it accepts
	// a superset); pin the floor so strictness never silently regresses.
	assert.ok(rejected >= 204, 'rejects ' + rejected + '/' + total + ' RFC-invalid selectors');
});
