import {
	isDiagnostic,
	query,
	type PadvinderDiagnostic,
	type PadvinderErrorCode,
	type QueryPath,
	type QueryRunner,
} from '../src/index.js';

const run: QueryRunner = query('$.rows[*]');
const paths: readonly QueryPath[] = run.paths;
const anchor: '$' | '@' = paths[0][0];
const step = paths[0][1];

if (step?.[0] === 'name') {
	const name: string = step[1];
	void name;
}

const results: any[] = run({});
const functions: readonly string[] = run.functions;
void anchor;
void results;
void functions;

const failure: unknown = null;
if (isDiagnostic(failure)) {
	const diagnostic: PadvinderDiagnostic = failure;
	const code: PadvinderErrorCode | undefined = failure.code;
	void diagnostic;
	void code;
}
if (run.isDiagnostic(failure)) {
	const diagnostic: PadvinderDiagnostic = failure;
	const code: PadvinderErrorCode | undefined = failure.code;
	void diagnostic;
	void code;
}

// @ts-expect-error metadata arrays are readonly
run.paths.push(['$']);
// @ts-expect-error path tuples are readonly
run.paths[0][0] = '@';
// @ts-expect-error function metadata is readonly
run.functions.push('extra');
