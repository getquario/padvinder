# Comparison benchmarks

This manual suite compares padvinder's published build with JSONPath Plus,
jsonpath-rfc9535, and the interpreted and JIT modes from
@jsonjoy.com/json-path. It is for understanding performance trade-offs, not
declaring a universal winner.

## Results (2026-07-22)

One post-optimization run on Node v24.15.0, macOS arm64. Versions: padvinder 0.3.0,
JSONPath Plus 10.4.0, jsonpath-rfc9535 1.3.0, and jsonjoy 18.28.0. Values
are median operations per second; the parenthesized number is throughput
relative to padvinder.

### Cold compile + run, 100 features

| Query | padvinder | JSONPath Plus | rfc9535 | jsonjoy eval | jsonjoy JIT |
| --- | ---: | ---: | ---: | ---: | ---: |
| Shallow | 191,314 (1.00x) | 121,571 (0.64x) | 284,242 (1.49x) | 984,425 (5.15x) | 245,257 (1.28x) |
| Deep | 74,021 (1.00x) | 36,030 (0.49x) | 79,550 (1.07x) | 219,643 (2.97x) | 109,074 (1.47x) |
| Conditional | 27,157 (1.00x) | 21,498 (0.79x) | 21,869 (0.81x) | 87,661 (3.23x) | 27,961 (1.03x) |
| Descendant | 9,972 (1.00x) | 11,981 (1.20x) | 27,739 (2.78x) | 40,146 (4.03x) | 40,508 (4.06x) |
| Compound | 19,393 (1.00x) | 15,959 (0.82x) | 15,442 (0.80x) | 61,321 (3.16x) | 14,594 (0.75x) |

### Hot run, 1,000 features

| Query | padvinder | JSONPath Plus | rfc9535 | jsonjoy eval | jsonjoy JIT |
| --- | ---: | ---: | ---: | ---: | ---: |
| Shallow | 26,016 (1.00x) | 13,497 (0.52x) | 45,821 (1.76x) | 123,918 (4.76x) | 142,424 (5.47x) |
| Deep | 8,911 (1.00x) | 3,784 (0.42x) | 9,784 (1.10x) | 23,169 (2.60x) | 25,546 (2.87x) |
| Conditional | 3,098 (1.00x) | 2,413 (0.78x) | 2,668 (0.86x) | 10,268 (3.31x) | 16,490 (5.32x) |
| Descendant | 998 (1.00x) | 1,194 (1.20x) | 2,866 (2.87x) | 3,999 (4.01x) | 4,756 (4.76x) |
| Compound | 2,038 (1.00x) | 1,579 (0.77x) | 1,797 (0.88x) | 6,607 (3.24x) | 7,937 (3.89x) |

The native-prepare diagnostic is omitted because the engine APIs do different
amounts of work at that stage.

## Run

Install the isolated benchmark dependencies once:

```sh
npm --prefix bench/comparison install
```

Then run from the repository root:

```sh
npm run bench:comparison
```

The command benchmarks `lib/index.js` directly — there is no build. Competitor
dependencies live under this directory, so a normal root install and CI do not
install them.

## Measurements

- **Cold compile + run** measures parsing or compilation and one execution.
- **Hot run** prepares each query before timing repeated execution.
- **Native prepare** is diagnostic only because the APIs do different work.

Every runner must first produce deeply equal values in the same order for
shallow, deep, filtered, descendant, and compound-filter queries.
Samples use adaptive batches, rotate engine order, and report median throughput
plus the full sample range.

JSONPath Plus uses its safe evaluator and populated path cache in the hot
benchmark. jsonpath-rfc9535 does not expose a reusable query runner, so its hot
measurement still parses each call. The jsonjoy interpreter reuses a parsed
path. Its JIT mode compiles a specialized runner.

`1.50x padvinder` means the engine completed 1.5 times as many operations per
second as padvinder in that workload. Ratios can exaggerate tiny absolute
differences, and results vary with Node version, hardware, power state, and
background activity. Compare repeated runs on the same machine.

The suite runs under normal Node because the jsonjoy JIT mode generates a
specialized runner. The existing `npm run bench` remains the zero-dependency
regression benchmark under the repository's strict-CSP simulation.
