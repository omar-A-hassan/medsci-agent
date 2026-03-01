import { afterEach, describe, expect, mock, test } from "bun:test";
import { createMockContext } from "@medsci/core";
import {
	computeTimeoutMs,
	pqaSidecar,
	searchAndAnalyzeTool,
} from "../tools/search-and-analyze";

describe("computeTimeoutMs (timeout hierarchy)", () => {
	test("scales with paper count, capped at 540s", () => {
		// 1 paper: base = 150s, llmBudget = (180+45)*1000 = 225s → max(150, 225) = 225s
		expect(computeTimeoutMs(1)).toBe(225_000);
		// 10 papers: base = 420s, llmBudget = 225s → max(420, 225) = 420s
		expect(computeTimeoutMs(10)).toBe(420_000);
		// 0 papers: base = 120s, llmBudget = 225s → max(120, 225) = 225s
		expect(computeTimeoutMs(0)).toBe(225_000);
	});

	test("ensures sidecar timeout >= LLM timeout + headroom", () => {
		const llmTimeout = 180;
		const headroomMs = 45_000;
		const result = computeTimeoutMs(1);
		expect(result).toBeGreaterThanOrEqual((llmTimeout + 45) * 1000);
	});

	test("never exceeds 540s (MCP has 600s)", () => {
		expect(computeTimeoutMs(100)).toBeLessThanOrEqual(540_000);
	});

	test("respects PQA_LLM_TIMEOUT_SECONDS env when set", () => {
		const origVal = process.env.PQA_LLM_TIMEOUT_SECONDS;
		try {
			process.env.PQA_LLM_TIMEOUT_SECONDS = "300";
			// 1 paper: base = 150s, llmBudget = (300+45)*1000 = 345s → 345s
			expect(computeTimeoutMs(1)).toBe(345_000);
		} finally {
			if (origVal === undefined) {
				delete process.env.PQA_LLM_TIMEOUT_SECONDS;
			} else {
				process.env.PQA_LLM_TIMEOUT_SECONDS = origVal;
			}
		}
	});
});

describe("search_and_analyze (IPC Serialization & Schema Boundaries)", () => {
	afterEach(() => {
		mock.restore();
	});

	test("rejects more than 10 papers gracefully (strictly bounded indexing)", async () => {
		const input = {
			query: "Test",
			papers: Array(11).fill({ identifier: "10.1234/test" }),
		};

		const result = searchAndAnalyzeTool.schema.safeParse(input);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.errors[0].message).toContain(
				"STRICT LIMIT: Maximum 10 papers allowed",
			);
		}
	});

	test("translates ACQUIRE_NONE_SUCCESS to agent-safe instruction", async () => {
		pqaSidecar.isRunning = mock(() => true);
		pqaSidecar.start = mock(() => Promise.resolve());
		const err = new Error("rate limit");
		(err as any).sidecar = {
			error_code: "ACQUIRE_NONE_SUCCESS",
			error_message: "No texts acquired",
			error_stage: "acquire",
			retryable: false,
		};
		pqaSidecar.call = mock(() => Promise.reject(err));

		const input = { query: "Test", papers: [{ identifier: "10.1234/test" }] };
		const ctx = createMockContext();
		const result = await searchAndAnalyzeTool.execute(input, ctx);

		expect(result.success).toBe(false);
		expect(result.error).toContain(
			"Could not acquire text for any requested papers",
		);
	});

	test("translates MODEL_NOT_FOUND to agent-safe instruction", async () => {
		pqaSidecar.isRunning = mock(() => true);
		pqaSidecar.start = mock(() => Promise.resolve());
		const err = new Error("missing models");
		(err as any).sidecar = {
			error_code: "MODEL_NOT_FOUND",
			error_message: "Missing required local models",
			error_stage: "startup",
			retryable: false,
		};
		pqaSidecar.call = mock(() => Promise.reject(err));

		const input = { query: "Test", papers: [{ identifier: "36856617" }] };
		const ctx = createMockContext();
		const result = await searchAndAnalyzeTool.execute(input, ctx);

		expect(result.success).toBe(false);
		expect(result.error).toContain("Configured local model was not found");
	});

	test("translates QUERY_TIMEOUT to agent-safe instruction", async () => {
		pqaSidecar.isRunning = mock(() => true);
		pqaSidecar.start = mock(() => Promise.resolve());
		const err = new Error("query timed out");
		(err as any).sidecar = {
			error_code: "QUERY_TIMEOUT",
			error_message: "LLM query timed out",
			error_stage: "query",
			retryable: true,
		};
		pqaSidecar.call = mock(() => Promise.reject(err));

		const input = { query: "Test", papers: [{ identifier: "10.1234/test" }] };
		const ctx = createMockContext();
		const result = await searchAndAnalyzeTool.execute(input, ctx);

		expect(result.success).toBe(false);
		expect(result.error).toContain("LLM query timed out");
	});

	test("translates QUERY_RATE_LIMIT to agent-safe instruction", async () => {
		pqaSidecar.isRunning = mock(() => true);
		pqaSidecar.start = mock(() => Promise.resolve());
		const err = new Error("rate limited");
		(err as any).sidecar = {
			error_code: "QUERY_RATE_LIMIT",
			error_message: "Rate limit exceeded",
			error_stage: "query",
			retryable: true,
		};
		pqaSidecar.call = mock(() => Promise.reject(err));

		const input = { query: "Test", papers: [{ identifier: "10.1234/test" }] };
		const ctx = createMockContext();
		const result = await searchAndAnalyzeTool.execute(input, ctx);

		expect(result.success).toBe(false);
		expect(result.error).toContain("rate-limited");
	});

	test("passes acquisition_summary through from sidecar result", async () => {
		pqaSidecar.isRunning = mock(() => true);
		pqaSidecar.start = mock(() => Promise.resolve());

		pqaSidecar.call = mock(async <T = unknown>(method: string, data: any) => {
			expect(method).toBe("analyze_papers");
			expect(data.query).toBe("Test checkpoint inhibitors");

			return {
				answer: "Checkpoint inhibitors show improved OS (Wolchok 2017).",
				references: ["Wolchok 2017"],
				context: ["..."],
				papers_indexed: 1,
				failed_downloads: [],
				stage_status: {
					acquire: "success",
					index: "success",
					query: "success",
				},
				warnings: [],
				acquisition_summary: {
					full_text: ["36856617"],
					abstract_only: [],
					cached: [],
					negative_cache_hits: [],
				},
			} as unknown as T;
		}) as any;

		const ctx = createMockContext();
		const result = await searchAndAnalyzeTool.execute(
			{
				query: "Test checkpoint inhibitors",
				papers: [
					{
						identifier: "36856617",
						title: "Checkpoint Inhibitor Combinations",
						authors: ["Wolchok, J"],
					},
				],
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.data?.answer).toContain("Checkpoint inhibitors");
		expect(result.data?.acquisition_summary.full_text).toContain("36856617");
		expect(result.data?.acquisition_summary.abstract_only).toHaveLength(0);
		expect(result.data?.stage_status.query).toBe("success");
		expect(pqaSidecar.call).toHaveBeenCalledTimes(1);
	});

	test("JSON serializes and transfers correctly when returning successful formatted answers", async () => {
		pqaSidecar.isRunning = mock(() => true);
		pqaSidecar.start = mock(() => Promise.resolve());

		pqaSidecar.call = mock(async <T = unknown>(method: string, data: any) => {
			expect(method).toBe("analyze_papers");
			expect(data.query).toBe("Test CRISPR");

			return {
				answer: "CRISPR is a gene editing tool (Doudna 2012).",
				references: ["Doudna 2012"],
				context: ["..."],
				stage_status: {
					acquire: "success",
					index: "success",
					query: "success",
				},
				warnings: [],
			} as unknown as T;
		}) as any;

		const ctx = createMockContext();
		const result = await searchAndAnalyzeTool.execute(
			{
				query: "Test CRISPR",
				papers: [
					{
						identifier: "10.1234/test",
						title: "Test Paper",
						citation_count: 50,
					},
				],
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.data?.answer).toContain("gene editing tool");
		expect(pqaSidecar.call).toHaveBeenCalledTimes(1);
	});
});
