# Comparison benchmarks

This manual suite compares padvinder against JSONPath Plus, jsonpath-rfc9535,
and the interpreted and JIT modes from @jsonjoy.com/json-path. It is for
understanding performance trade-offs, not declaring a universal winner.

## Results (2026-08-16)

One run on Node v24.18.0, macOS arm64. Versions: padvinder 0.3.1,
JSONPath Plus 10.4.0, jsonpath-rfc9535 1.3.0, and jsonjoy 18.28.0. Values
are median operations per second; the parenthesized number is throughput
relative to padvinder.

### Cold compile + run, 100 features

| Query       |       padvinder |   JSONPath Plus |         rfc9535 |    jsonjoy eval |     jsonjoy JIT |
| ----------- | --------------: | --------------: | --------------: | --------------: | --------------: |
| Shallow     | 207,020 (1.00x) | 130,007 (0.63x) | 290,175 (1.40x) | 974,872 (4.71x) | 246,418 (1.19x) |
| Deep        |  77,382 (1.00x) |  36,480 (0.47x) |  80,633 (1.04x) | 220,886 (2.85x) | 110,815 (1.43x) |
| Conditional |  27,345 (1.00x) |  21,633 (0.79x) |  22,739 (0.83x) |  90,479 (3.31x) |  28,006 (1.02x) |
| Descendant  |  10,064 (1.00x) |  12,091 (1.20x) |  28,011 (2.78x) |  39,859 (3.96x) |  41,266 (4.10x) |
| Compound    |  19,516 (1.00x) |  15,730 (0.81x) |  16,272 (0.83x) |  61,355 (3.14x) |  14,376 (0.74x) |

### Hot run, 1,000 features

| Query       |      padvinder |  JSONPath Plus |        rfc9535 |    jsonjoy eval |     jsonjoy JIT |
| ----------- | -------------: | -------------: | -------------: | --------------: | --------------: |
| Shallow     | 28,745 (1.00x) | 13,548 (0.47x) | 45,424 (1.58x) | 124,708 (4.34x) | 135,868 (4.73x) |
| Deep        |  9,358 (1.00x) |  3,696 (0.40x) |  9,813 (1.05x) |  23,339 (2.49x) |  25,586 (2.73x) |
| Conditional |  3,155 (1.00x) |  2,418 (0.77x) |  2,672 (0.85x) |  10,282 (3.26x) |  16,537 (5.24x) |
| Descendant  |    999 (1.00x) |  1,203 (1.20x) |  2,889 (2.89x) |   3,956 (3.96x) |   4,762 (4.77x) |
| Compound    |  2,066 (1.00x) |  1,570 (0.76x) |  1,716 (0.83x) |   6,718 (3.25x) |   7,868 (3.81x) |

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
