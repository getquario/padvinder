import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JsonPathCodegen, JsonPathEval, JsonPathParser } from '@jsonjoy.com/json-path';
import { JSONPath } from 'jsonpath-plus';
import { query as rfcQuery } from 'jsonpath-rfc9535';
import parseRfc from 'jsonpath-rfc9535/parser';
import { find, query } from '../../lib/index.js';

const require = createRequire(import.meta.url);
const versions = {
	padvinder: require('../../package.json').version,
	'jsonpath-plus': require('jsonpath-plus/package.json').version,
	rfc9535: require('jsonpath-rfc9535/package.json').version,
	'jsonjoy-eval': require('@jsonjoy.com/json-path/package.json').version,
	'jsonjoy-jit': require('@jsonjoy.com/json-path/package.json').version,
};

const paths = {
	shallow: '$.features[*]',
	deep: '$.features[*].properties.STREET',
	conditional: '$.features[?@.properties.STREET == "UNKNOWN"].geometry.coordinates',
	descendant: '$..coordinates',
	compound: '$.features[?@.properties.active == true && @.properties.LOT >= 500].properties.LOT',
};

function joyPath(path) {
	const result = JsonPathParser.parse(path);
	assert.equal(result.success, true, result.error);
	return result.path;
}

const plusPath = path => path.replace(/\[\?([^\]]+)\]/g, '[?($1)]');
const values = result => result.map(value => value.data);

const engines = [
	{
		name: 'padvinder',
		prepare: path => query(path),
		make: path => query(path),
		cold: (path, data) => find(path, data),
	},
	{
		name: 'jsonpath-plus',
		prepare(path) {
			JSONPath.cache = {};
			return JSONPath.toPathArray(plusPath(path));
		},
		make(path) {
			JSONPath.cache = {};
			const source = plusPath(path);
			return data => JSONPath({ path: source, json: data, eval: 'safe' });
		},
		cold(path, data) {
			JSONPath.cache = {};
			return JSONPath({ path: plusPath(path), json: data, eval: 'safe' });
		},
	},
	{
		name: 'rfc9535',
		prepare: parseRfc,
		make: path => data => rfcQuery(data, path),
		cold: (path, data) => rfcQuery(data, path),
	},
	{
		name: 'jsonjoy-eval',
		prepare: joyPath,
		make(path) {
			const parsed = joyPath(path);
			return data => values(new JsonPathEval(parsed, data).eval());
		},
		cold: (path, data) => values(JsonPathEval.run(path, data)),
	},
	{
		name: 'jsonjoy-jit',
		prepare: path => JsonPathCodegen.compile(path),
		make(path) {
			const run = JsonPathCodegen.compile(path);
			return data => values(run(data));
		},
		cold: (path, data) => values(JsonPathCodegen.compile(path)(data)),
	},
];

let sink = 0;

function consume(value) {
	sink += Array.isArray(value) ? value.length : value ? 1 : 0;
}

function fixture(size) {
	return {
		type: 'FeatureCollection',
		features: Array.from({ length: size }, (_, i) => ({
			type: 'Feature',
			properties: {
				STREET: i % 10 === 0 ? 'UNKNOWN' : `STREET ${i % 100}`,
				LOT: i,
				active: i % 2 === 0,
			},
			geometry: {
				type: 'Point',
				coordinates: [i, i + 1],
			},
		})),
	};
}

function batch(fn, n) {
	for (let i = 0; i < n; i++) consume(fn());
}

function calibrate(fn) {
	let n = 1;
	for (;;) {
		const start = performance.now();
		batch(fn, n);
		if (performance.now() - start >= 2 || n >= 1e6) return n;
		n *= 2;
	}
}

function sample(fn, n) {
	let ops = 0;
	const start = performance.now();
	let elapsed;
	do {
		batch(fn, n);
		ops += n;
		elapsed = performance.now() - start;
	} while (elapsed < 100);
	return ops / (elapsed / 1e3);
}

function median(values) {
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

function benchmark(title, items, relative = true) {
	const results = new Map(items.map(item => [item.name, []]));
	const sizes = new Map();

	for (const item of items) {
		const start = performance.now();
		while (performance.now() - start < 30) consume(item.fn());
		sizes.set(item.name, calibrate(item.fn));
	}

	for (let round = 0; round < 5; round++) {
		for (let i = 0; i < items.length; i++) {
			const item = items[(i + round) % items.length];
			results.get(item.name).push(sample(item.fn, sizes.get(item.name)));
		}
	}

	const baseline = median(results.get('padvinder'));
	console.log('\n' + title);
	for (const item of items) {
		const samples = results.get(item.name);
		const rate = median(samples);
		const spread = (Math.max(...samples) - Math.min(...samples)) / rate * 100;
		const ratio = relative ? `  ${(rate / baseline).toFixed(2)}x padvinder` : '';
		console.log(
			`  ${item.name.padEnd(14)} ${Math.round(rate).toLocaleString().padStart(14)} ops/sec` +
			`  ${spread.toFixed(1).padStart(5)}% range${ratio}`
		);
	}
}

for (const size of [100, 1_000]) {
	const data = fixture(size);
	for (const [name, path] of Object.entries(paths)) {
		const expected = query(path)(data);
		for (const engine of engines) {
			assert.deepEqual(engine.make(path)(data), expected, `${engine.name}: ${name}, ${size} features`);
		}
	}
}

console.log(`Node ${process.version} · ${process.platform} ${process.arch}`);
console.log(engines.map(engine => `${engine.name} ${versions[engine.name]}`).join(' · '));
console.log('All runners produced identical output.');

benchmark(
	'Native prepare, compound filter (diagnostic; APIs are not equivalent)',
	engines.map(engine => ({ name: engine.name, fn: () => engine.prepare(paths.compound) })),
	false
);

const cold = fixture(100);
for (const [name, path] of Object.entries(paths)) {
	benchmark(
		`Cold compile + run, ${name}, 100 features`,
		engines.map(engine => ({ name: engine.name, fn: () => engine.cold(path, cold) }))
	);
}

const hot = fixture(1_000);
for (const [name, path] of Object.entries(paths)) {
	benchmark(
		`Hot run, ${name}, 1,000 features`,
		engines.map(engine => {
			const run = engine.make(path);
			return { name: engine.name, fn: () => run(hot) };
		})
	);
}

if (sink < 0) console.log(sink);
