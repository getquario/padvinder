// Manual micro- and scaling benchmarks for padvinder. Run with `npm run bench`.
import assert from "node:assert/strict";
import { find, query } from "../lib/index.js";

let sink = 0;

function consume(value) {
  sink += Array.isArray(value) ? value.length : typeof value === "function" ? 1 : 0;
}

function micro(name, fn) {
  for (let t = performance.now(); performance.now() - t < 50;) consume(fn());
  let best = 0;
  for (let sample = 0; sample < 5; sample++) {
    let ops = 0;
    const start = performance.now();
    let elapsed;
    do {
      for (let i = 0; i < 100; i++) consume(fn());
      ops += 100;
      elapsed = performance.now() - start;
    } while (elapsed < 100);
    best = Math.max(best, ops / (elapsed / 1e3));
  }
  console.log(name.padEnd(30), Math.round(best).toLocaleString().padStart(14), "ops/sec");
}

function elapsed(name, fn) {
  consume(fn());
  let best = Infinity;
  for (let sample = 0; sample < 3; sample++) {
    const start = performance.now();
    const result = fn();
    const duration = performance.now() - start;
    consume(result);
    best = Math.min(best, duration);
  }
  console.log(name.padEnd(30), best.toFixed(3).padStart(14), "ms");
}

function fixture(size) {
  return {
    type: "FeatureCollection",
    features: Array.from({ length: size }, (_, i) => ({
      type: "Feature",
      properties: {
        STREET: i % 10 === 0 ? "UNKNOWN" : `STREET ${i % 100}`,
        LOT: i,
        active: i % 2 === 0,
      },
      geometry: {
        type: "Point",
        coordinates: [i, i + 1],
      },
    })),
  };
}

const paths = {
  shallow: "$.features[*]",
  deep: "$.features[*].properties.STREET",
  conditional: '$.features[?@.properties.STREET == "UNKNOWN"].geometry.coordinates',
  descendant: "$..coordinates",
  compound: "$.features[?@.properties.active == true && @.properties.LOT >= 500].properties.LOT",
};

const runners = Object.fromEntries(
  Object.entries(paths).map(([name, path]) => [name, query(path)]),
);

function expected(size) {
  return {
    shallow: size,
    deep: size,
    conditional: Math.ceil(size / 10),
    descendant: size,
    compound: Math.max(0, Math.ceil((size - 500) / 2)),
  };
}

function validate(data, size) {
  const counts = expected(size);
  for (const [name, runner] of Object.entries(runners)) {
    assert.equal(runner(data).length, counts[name], `${name} result count`);
  }
}

console.log(`Node ${process.version} · ${process.platform} ${process.arch}`);
console.log("\nMicrobenchmarks (best of 5)");

const small = fixture(100);
validate(small, 100);
micro("compile: shallow", () => query(paths.shallow));
micro("compile: compound filter", () => query(paths.compound));
micro("run: shallow (100)", () => runners.shallow(small));
micro("run: conditional (100)", () => runners.conditional(small));
micro("find: shallow (100)", () => find(paths.shallow, small));

console.log("\nScaling, precompiled (best of 3)");
for (const size of [100, 1_000, 10_000]) {
  const data = fixture(size);
  validate(data, size);
  console.log(`\n${size.toLocaleString()} features`);
  for (const [name, runner] of Object.entries(runners)) {
    elapsed(name, () => runner(data));
  }
}

if (sink < 0) console.log(sink);
