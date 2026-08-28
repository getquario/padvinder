/**
 * Optional per-execution traversal budgets.
 */
export interface QueryOptions {
  maxNodes?: number;
  maxDepth?: number;
  maxResults?: number;
}
export type PadvinderErrorCode =
  | "PADVINDER_SYNTAX"
  | "PADVINDER_MAX_NODES"
  | "PADVINDER_MAX_DEPTH"
  | "PADVINDER_MAX_RESULTS"
  | "PADVINDER_MAX_COMPARISONS";
export interface PadvinderDiagnostic extends Error {
  readonly code?: PadvinderErrorCode;
  readonly limit?: number;
  readonly actual?: number;
  /** Zero-based offset into the query. Compile-time diagnostics only. */
  readonly start?: number;
  /** Exclusive offset into the query. Compile-time diagnostics only. */
  readonly end?: number;
}
/** Test whether an error was created by this padvinder module instance. */
export function isDiagnostic(error: unknown): error is PadvinderDiagnostic;

/**
 * Copy a diagnostic into an embedder's coordinates: `prefix` is prepended to
 * the message verbatim, `offset` shifts the span when there is one, every
 * other field is carried over, and the copy is authenticated exactly as the
 * original was.
 *
 * @throws {TypeError} When `diag` is not a diagnostic from this instance.
 */
export function relocate(
  diag: unknown,
  opts?: { prefix?: string; offset?: number },
): PadvinderDiagnostic;

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
