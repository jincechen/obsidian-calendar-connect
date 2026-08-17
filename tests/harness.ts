// A deliberately tiny assertion harness: every check compares JSON encodings,
// so failures print both sides in a readable form. `spec.ts` prints the summary.

let passed = 0;
const failures: string[] = [];

export function check(name: string, actual: unknown, expected: unknown): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) passed++;
	else failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
}

/** Passes when `fn` throws an instance of `ErrorType` (any Error when omitted). */
export function throws(name: string, fn: () => unknown, ErrorType: new (...args: never[]) => Error = Error): void {
	try {
		fn();
		failures.push(`${name}\n    expected ${ErrorType.name}, but it returned normally`);
	} catch (error) {
		if (error instanceof ErrorType) passed++;
		else failures.push(`${name}\n    expected ${ErrorType.name}, got ${(error as Error)?.message ?? String(error)}`);
	}
}

/** Async counterpart of `throws`; await it before the summary is printed. */
export async function rejects(
	name: string,
	fn: () => Promise<unknown>,
	ErrorType: new (...args: never[]) => Error = Error
): Promise<void> {
	try {
		await fn();
		failures.push(`${name}\n    expected ${ErrorType.name}, but it resolved`);
	} catch (error) {
		if (error instanceof ErrorType) passed++;
		else failures.push(`${name}\n    expected ${ErrorType.name}, got ${(error as Error)?.message ?? String(error)}`);
	}
}

/** Async tests register here so `spec.ts` can await them all before reporting. */
const pending: Array<Promise<unknown>> = [];
export function later(task: () => Promise<unknown>): void {
	pending.push(
		task().catch((error: unknown) => {
			failures.push(`async test crashed: ${(error as Error)?.stack ?? String(error)}`);
		})
	);
}

export async function report(): Promise<number> {
	await Promise.all(pending);
	console.log(`\n${passed} passed, ${failures.length} failed`);
	for (const failure of failures) console.log(`\n  ✗ ${failure}`);
	return failures.length;
}
