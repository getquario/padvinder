import { FIXTURE, collect, findSafe, snap } from "./lib.js";

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

  // Provenance: every result is a genuine location in FIXTURE. Objects match
  // by identity (root allowed via nodes); primitives by value-set membership.
  for (const r of out) {
    if (r !== null && typeof r === "object") {
      if (!nodes.has(r)) throw new Error("result object is not a node of the data");
    } else if (!leaves.has(r)) {
      throw new Error("result primitive is not a leaf of the data");
    }
  }
}
