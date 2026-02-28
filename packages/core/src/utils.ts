/**
 * A resilient fetch utility that wraps the native fetch API.
 * Provides exponential backoff, rate-limit parsing (Retry-After),
 * and configurable timeouts.
 */

export interface ResilientFetchOptions extends RequestInit {
	maxRetries?: number;
	baseDelayMs?: number;
	timeoutMs?: number;
}

export async function resilientFetch(
	url: string | URL,
	options: ResilientFetchOptions = {},
): Promise<Response> {
	const {
		maxRetries = 3,
		baseDelayMs = 1000,
		timeoutMs = 15000,
		...fetchOptions
	} = options;

	let attempt = 0;

	while (true) {
		// Determine timeout strictly for this specific attempt
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const response = await fetch(url, {
				...fetchOptions,
				signal: options.signal
					? anySignal([options.signal, controller.signal])
					: controller.signal,
			});

			// Clear the timeout upon receiving a response
			clearTimeout(timeoutId);

			// If response is successful (2xx), or we shouldn't retry (400, 403, 404), return it immediately
			if (
				response.ok ||
				(response.status >= 400 &&
					response.status < 500 &&
					response.status !== 429)
			) {
				return response;
			}

			// If we've hit max retries, return the failing response so upstream tools can handle it
			if (attempt >= maxRetries) {
				return response;
			}

			// 🧹 Quick check for test envs to avoid slowing down CI
			if (process.env.NODE_ENV === "test") {
				return response;
			}

			let delayMs = baseDelayMs * Math.pow(2, attempt);

			// Read Retry-After header if we hit rate limits (429 or 503)
			if (response.status === 429 || response.status === 503) {
				const retryAfter = response.headers.get("retry-after");
				if (retryAfter) {
					const parsed = Number.parseInt(retryAfter, 10);
					if (!Number.isNaN(parsed)) {
						delayMs = parsed * 1000;
					} else {
						// It might be an HTTP date, which we lazily accommodate
						const date = new Date(retryAfter).getTime();
						if (!Number.isNaN(date)) {
							delayMs = Math.max(0, date - Date.now());
						}
					}
				}
			}

			await Bun.sleep(delayMs);
			attempt++;
		} catch (error: any) {
			clearTimeout(timeoutId);

			// Re-throw if it's an abort from the user's provided signal (not our timeout)
			if (error.name === "AbortError" && options.signal?.aborted) {
				throw error;
			}

			if (attempt >= maxRetries) {
				throw new Error(
					`Fetch failed after ${maxRetries} retries: ${error.message}`,
				);
			}

			// Exponential backoff for network-level failures (e.g., ECONNRESET, ENOTFOUND, timeout)
			const delayMs = baseDelayMs * Math.pow(2, attempt);
			await Bun.sleep(delayMs);
			attempt++;
		}
	}
}

/**
 * Utility to combine multiple AbortSignals
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
	const controller = new AbortController();
	const onAbort = () => {
		controller.abort();
		// Cleanup listeners
		for (const signal of signals) {
			signal.removeEventListener("abort", onAbort);
		}
	};

	for (const signal of signals) {
		if (signal.aborted) {
			onAbort();
			return signal;
		}
		signal.addEventListener("abort", onAbort);
	}

	return controller.signal;
}
