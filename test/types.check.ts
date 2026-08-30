import type { TrefferErrorCode } from "treffer";
import {
  isDiagnostic,
  query,
  relocate,
  type PadvinderDiagnostic,
  type PadvinderErrorCode,
  type QueryPath,
  type QueryRunner,
} from "../lib/index.js";

const run: QueryRunner = query("$.rows[*]");
const paths: readonly QueryPath[] = run.paths;
const anchor: "$" | "@" = paths[0][0];
const step = paths[0][1];

if (step?.[0] === "name") {
  const name: string = step[1];
  void name;
}

const results: any[] = run({});
const functions: readonly string[] = run.functions;
const singular: boolean = run.singular;
void anchor;
void results;
void functions;
void singular;

const failure: unknown = null;
if (isDiagnostic(failure)) {
  const diagnostic: PadvinderDiagnostic = failure;
  // Widened by design: a pattern literal rejected at compile time carries
  // Treffer's code, because Treffer is what decided the pattern was wrong.
  const code: PadvinderErrorCode | TrefferErrorCode | undefined = failure.code;
  const moved: PadvinderDiagnostic = relocate(failure, { prefix: "data: ", offset: 1 });
  const replaced: PadvinderDiagnostic = relocate(failure, { span: [16, 24] });
  void diagnostic;
  void code;
  void [moved, replaced];
}
if (run.isDiagnostic(failure)) {
  const diagnostic: PadvinderDiagnostic = failure;
  const code: PadvinderErrorCode | TrefferErrorCode | undefined = failure.code;
  void diagnostic;
  void code;
}

// @ts-expect-error metadata arrays are readonly
run.paths.push(["$"]);
// @ts-expect-error path tuples are readonly
run.paths[0][0] = "@";
// @ts-expect-error function metadata is readonly
run.functions.push("extra");
