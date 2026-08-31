import type { Diagnostic, Relocation } from "waarmerk";
import type { TrefferErrorCode } from "treffer";

// Re-exported so an embedder can name the codes a delegated pattern fault
// carries from 'padvinder' alone, without a treffer dependency of its own.
export type { TrefferErrorCode } from "treffer";

/**
 * Optional per-execution traversal budgets. `maxDepth` defaults to 500 so a
 * deep untrusted document throws a typed diagnostic instead of overflowing
 * the native stack; the other two default to unbounded. An explicit
 * `Infinity` opts any budget out.
 */
export interface QueryOptions {
  maxNodes?: number;
  maxDepth?: number;
  maxResults?: number;
}
/**
 * The categories of mistake padvinder itself mints. A code names the category,
 * not the exact fault: which of several ways a string literal is malformed is
 * the message's job, not a consumer's to branch on.
 *
 * `PADVINDER_SYNTAX` is the residue — an unexpected character in a path, and a
 * filter body that does not parse. There is no finite set of ways to write
 * something that is not a query, so those share one category rather than being
 * enumerated, and this union stays open at that end.
 */
export type PadvinderErrorCode =
  | "PADVINDER_SYNTAX"
  | "PADVINDER_MISSING_ROOT"
  | "PADVINDER_BAD_SELECTOR"
  | "PADVINDER_UNCLOSED_BRACKET"
  | "PADVINDER_BAD_STRING"
  | "PADVINDER_UNKNOWN_FUNCTION"
  | "PADVINDER_MAX_NODES"
  | "PADVINDER_MAX_DEPTH"
  | "PADVINDER_MAX_RESULTS"
  | "PADVINDER_MAX_COMPARISONS";
/**
 * The fields and their meanings are waarmerk's; this names the code union they
 * are checked against, Treffer's included.
 *
 * `code` is widened with `TrefferErrorCode` because a pattern literal rejected
 * when the query compiles keeps the code Treffer gave it: a host can still tell
 * a malformed pattern from one over budget.
 *
 * `start`/`end` are offsets into the query, on compile-time diagnostics — with
 * one addition. A pattern literal rejected for exceeding one of Treffer's
 * budgets carries a span too. That diagnostic has no position in the pattern,
 * which is Treffer's coordinate system, but the literal has one in the query.
 */
export interface PadvinderDiagnostic extends Diagnostic<PadvinderErrorCode | TrefferErrorCode> {}

/** Test whether an error was created by this padvinder module instance. */
export function isDiagnostic(error: unknown): error is PadvinderDiagnostic;

/**
 * Copy a diagnostic into an embedder's coordinates: `prefix` is prepended to
 * the message verbatim, the span is moved when there is one, every other field
 * is carried over, and the copy is authenticated exactly as the original was.
 *
 * `offset` shifts the span, for an embedder that handed over a verbatim slice
 * of its own text. `span` replaces it, for one whose text reached the query
 * through a decode and so has no offset to shift. `span` wins when both are
 * given.
 *
 * @throws {TypeError} When `diag` is not a diagnostic from this instance.
 */
export function relocate(diag: unknown, opts?: Relocation): PadvinderDiagnostic;

export type QuerySelector =
  | readonly ["name", string]
  | readonly ["index", number]
  | readonly ["wildcard"]
  | readonly ["union", ...QuerySelector[]]
  | readonly ["slice", number | null, number | null, number]
  | readonly ["filter"]
  | readonly ["descendant", QuerySelector];
export type QueryPath = readonly ["$", ...QuerySelector[]] | readonly ["@", ...QuerySelector[]];
export interface QueryRunner {
  (data?: any): any[];
  readonly functions: readonly string[];
  readonly paths: readonly QueryPath[];
  /**
   * Whether this is a singular query per RFC 9535 — every segment selects at
   * most one node, so the whole query selects at most one. What a consumer
   * asks before binding a result as a scalar rather than a list.
   */
  readonly singular: boolean;
  /** Test whether a runtime diagnostic was created by this runner. */
  isDiagnostic(error: unknown): error is PadvinderDiagnostic;
}
/**
 * Compile a JSONPath query once, run it many times.
 *
 * The runner exposes frozen `paths`/`functions` metadata and a runner-scoped
 * `isDiagnostic(error)` predicate for runtime faults it creates.
 *
 * @param {string} path The query, e.g. `'$.store.book[?@.price < 10].title'`.
 * @param {Record<string, Function>} [funcs] Custom function extensions callable in filters, alongside the built-in `length`, `count`, `value`, `match`, and `search`.
 * @returns {(data?: any) => any[]} Runner returning all matches (empty array for none).
 * @throws {SyntaxError} On malformed paths or filters.
 */
export function query(
  path: string,
  funcs?: Record<string, Function>,
  options?: QueryOptions | null,
): QueryRunner;
/**
 * Compile and run a JSONPath query in one go.
 *
 * @param {string} path The query to run.
 * @param {any} [data] The data to query.
 * @param {Record<string, Function>} [funcs] Functions callable inside filters.
 * @returns {any[]} All matches (empty array for none).
 */
export function find(
  path: string,
  data?: any,
  funcs?: Record<string, Function>,
  options?: QueryOptions | null,
): any[];
