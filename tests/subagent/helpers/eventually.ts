export async function eventually(
	assertion: () => void,
	timeoutMs = 1_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;

	do {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
		}

		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	} while (Date.now() < deadline);

	throw (
		lastError ?? new Error("Condition did not become true before the timeout.")
	);
}
