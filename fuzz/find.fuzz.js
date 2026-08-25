import { FIXTURE, assertReachable, collect, findSafe, snap } from "./lib.js";

const { nodes, leaves } = collect(FIXTURE);
const before = snap(FIXTURE);

export function fuzz(data) {
  const path = data.toString("utf8");
  let out;
  try {
    out = findSafe(path, FIXTURE);
  } finally {
    // A query must never mutate the data, even on the throwing path.
    if (snap(FIXTURE) !== before) throw new Error("query mutated the data");
  }
  if (out === undefined) return; // malformed path — expected SyntaxError

  assertReachable(out, nodes, leaves);
}
