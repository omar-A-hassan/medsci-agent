import { mock } from "bun:test";
import type { ToolContext } from "../types";

/**
 * Creates a mock ToolContext for unit testing tools.
 * All methods are mocked with sensible defaults.
 *
 * @param overrides - Optional partial overrides for specific mock behaviors
 * @param overrides.pythonResponse - Default response for ctx.python.call()
 * @param overrides.generateResponse - Default response for ctx.ollama.generate()
 * @param overrides.generateJsonResponse - Default response for ctx.ollama.generateJson()
 */
export function createMockContext(overrides?: {
	pythonResponse?: unknown;
	generateResponse?: string;
	generateJsonResponse?: unknown;
}): ToolContext {
	return {
		ollama: {
			generate: mock(() =>
				Promise.resolve(overrides?.generateResponse ?? "Mock interpretation."),
			),
			generateJson: mock(<T = unknown>() =>
				Promise.resolve((overrides?.generateJsonResponse ?? {}) as T),
			) as any,
			embed: mock(() => Promise.resolve([])),
			classify: mock(() =>
				Promise.resolve({ label: "ok", score: 0.9, allScores: {} }),
			),
			isAvailable: mock(() => Promise.resolve(true)),
		},
		python: {
			call: mock(<T = unknown>() =>
				Promise.resolve((overrides?.pythonResponse ?? {}) as T),
			) as any,
			isRunning: () => true,
			start: mock(() => Promise.resolve()),
			stop: mock(() => Promise.resolve()),
		},
		log: {
			debug: mock(() => {}),
			info: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
		},
	};
}
