# Comparison benchmarks

This manual suite compares padvinder against JSONPath Plus, jsonpath-rfc9535,
and the interpreted and JIT modes from @jsonjoy.com/json-path. It is for
understanding performance trade-offs, not declaring a universal winner.

## Results (2026-09-18)

One run on Node v24.18.0, macOS arm64. Versions: padvinder 0.9.0 plus the
unreleased segment-expansion change, JSONPath Plus 10.4.0,
jsonpath-rfc9535 1.3.0, and jsonjoy 18.30.0. Values are median operations per
second; the parenthesized number is throughput relative to padvinder.

### Cold compile + run, 100 features

| Query       |       padvinder |   JSONPath Plus |         rfc9535 |    jsonjoy eval |     jsonjoy JIT |
| ----------- | --------------: | --------------: | --------------: | --------------: | --------------: |
| Shallow     | 245,272 (1.00x) | 127,113 (0.52x) | 289,799 (1.18x) | 984,365 (4.01x) | 245,443 (1.00x) |
| Deep        |  82,652 (1.00x) |  36,771 (0.44x) |  81,225 (0.98x) | 220,774 (2.67x) | 111,690 (1.35x) |
| Conditional |  45,766 (1.00x) |  21,918 (0.48x) |  23,240 (0.51x) |  92,573 (2.02x) |  27,989 (0.61x) |
| Descendant  |  10,372 (1.00x) |  12,225 (1.18x) |  27,894 (2.69x) |  39,960 (3.85x) |  40,296 (3.89x) |
| Compound    |  29,960 (1.00x) |  16,206 (0.54x) |  16,102 (0.54x) |  62,295 (2.08x) |  14,736 (0.49x) |

### Hot run, 1,000 features

| Query       |      padvinder |  JSONPath Plus |        rfc9535 |    jsonjoy eval |     jsonjoy JIT |
| ----------- | -------------: | -------------: | -------------: | --------------: | --------------: |
| Shallow     | 33,069 (1.00x) | 13,530 (0.41x) | 45,280 (1.37x) | 124,473 (3.76x) | 142,455 (4.31x) |
| Deep        |  9,359 (1.00x) |  3,740 (0.40x) |  9,837 (1.05x) |  22,834 (2.44x) |  25,428 (2.72x) |
| Conditional |  5,734 (1.00x) |  2,451 (0.43x) |  2,833 (0.49x) |  10,240 (1.79x) |  16,679 (2.91x) |
| Descendant  |  1,046 (1.00x) |  1,221 (1.17x) |  2,908 (2.78x) |   4,003 (3.83x) |   4,790 (4.58x) |
| Compound    |  3,284 (1.00x) |  1,601 (0.49x) |  1,721 (0.52x) |   6,639 (2.02x) |   7,967 (2.43x) |

The previous table was recorded against 0.3.1. Re-running it on this machine
found that 0.4.0 through 0.9.0 ran 8% to 20% slower than 0.3.1 on every query,
which a bisect traced to one refactor. The segment expansion and the child walk
now avoid the array-protocol work that refactor introduced, which recovers the
loss and passes it: a filter segment runs about 1.9x and a name segment about
1.3x what 0.9.0 does.

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
