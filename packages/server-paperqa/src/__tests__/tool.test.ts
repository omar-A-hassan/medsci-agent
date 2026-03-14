import { afterEach, describe, expect, mock, test } from "bun:test";
import { createMockContext } from "@medsci/core/testing";
import {
	computeTimeoutMs,
	pqaSidecar,
	searchAndAnalyzeTool,
} from "../tools/search-and-analyze";

const originalIsRunning = pqaSidecar.isRunning.bind(pqaSidecar);
const originalStart = pqaSidecar.start.bind(pqaSidecar);
const originalCall = pqaSidecar.call.bind(pqaSidecar);

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

	test("PQA_QUERY_TIMEOUT_MS direct override takes precedence", () => {
		const origVal = process.env.PQA_QUERY_TIMEOUT_MS;
		try {
			process.env.PQA_QUERY_TIMEOUT_MS = "30000";
			expect(computeTimeoutMs(1)).toBe(30_000);
		} finally {
			if (origVal === undefined) delete process.env.PQA_QUERY_TIMEOUT_MS;
			else process.env.PQA_QUERY_TIMEOUT_MS = origVal;
		}
	});

	test("PQA_QUERY_TIMEOUT_MS is capped at 540s", () => {
		const origVal = process.env.PQA_QUERY_TIMEOUT_MS;
		try {
			process.env.PQA_QUERY_TIMEOUT_MS = "600000";
			expect(computeTimeoutMs(1)).toBe(540_000);
		} finally {
			if (origVal === undefined) delete process.env.PQA_QUERY_TIMEOUT_MS;
			else process.env.PQA_QUERY_TIMEOUT_MS = origVal;
		}
	});

	test("PQA_QUERY_TIMEOUT_MS=0 falls through to normal logic", () => {
		const origVal = process.env.PQA_QUERY_TIMEOUT_MS;
		try {
			process.env.PQA_QUERY_TIMEOUT_MS = "0";
			// Normal path: 1 paper → 225s
			expect(computeTimeoutMs(1)).toBe(225_000);
		} finally {
			if (origVal === undefined) delete process.env.PQA_QUERY_TIMEOUT_MS;
			else process.env.PQA_QUERY_TIMEOUT_MS = origVal;
		}
	});
});

describe("search_and_analyze (IPC Serialization & Schema Boundaries)", () => {
	afterEach(() => {
		pqaSidecar.isRunning = originalIsRunning;
		pqaSidecar.start = originalStart;
		pqaSidecar.call = originalCall;
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

	test("accepts documents-only input", () => {
		const input = {
			query: "Test",
			documents: [
				{
					source_id: "doc-1",
					source_type: "doi",
					provenance_url: "https://example.org/paper",
					retrieval_method: "scrapling_html",
					license_hint: "unknown",
					text: "full text body",
					text_hash: "1234567890abcdef",
					metadata: {},
					extraction_confidence: 0.8,
					extraction_backend: "scrapling",
					fallback_used: false,
					policy: { allowed: true, blocked: false },
				},
			],
		};

		const result = searchAndAnalyzeTool.schema.safeParse(input);
		expect(result.success).toBe(true);
	});

	test("accepts legacy papers string array and normalizes to object shape", async () => {
		pqaSidecar.isRunning = mock(() => true);
		pqaSidecar.start = mock(() => Promise.resolve());

		pqaSidecar.call = mock(async <T = unknown>(method: string, data: any) => {
			expect(method).toBe("analyze_papers");
			expect(data.query).toBe("Test legacy papers format");
			expect(data.papers).toEqual([
				{ identifier: "10.1038/ncomms3192" },
				{ identifier: "10.1007/s00125-017-4342-z" },
			]);
			return {
				answer: "ok",
				references: [],
				context: "",
				stage_status: { acquire: "success", index: "success", query: "success" },
				warnings: [],
			} as unknown as T;
		}) as any;

		const parseResult = searchAndAnalyzeTool.schema.safeParse({
			query: "Test legacy papers format",
			papers: ["10.1038/ncomms3192", "10.1007/s00125-017-4342-z"],
		});
		expect(parseResult.success).toBe(true);
		if (parseResult.success) {
			expect(parseResult.data.papers).toEqual([
				{ identifier: "10.1038/ncomms3192" },
				{ identifier: "10.1007/s00125-017-4342-z" },
			]);
		}

		const ctx = createMockContext();
		const result = await searchAndAnalyzeTool.execute(
			{
				query: "Test legacy papers format",
				papers: ["10.1038/ncomms3192", "10.1007/s00125-017-4342-z"] as any,
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(pqaSidecar.call).toHaveBeenCalledTimes(1);
	});

	test("rejects empty papers and documents at execute time", async () => {
		pqaSidecar.isRunning = mock(() => true);
		const ctx = createMockContext();
		const result = await searchAndAnalyzeTool.execute(
			{ query: "Test", papers: [], documents: [] },
			ctx,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("at least one");
	});

	test("schema exposes .shape for MCP registration (no ZodEffects wrapper)", () => {
		expect("shape" in searchAndAnalyzeTool.schema).toBe(true);
		const shape = (searchAndAnalyzeTool.schema as any).shape;
		expect(shape).toHaveProperty("query");
		expect(shape).toHaveProperty("papers");
		expect(shape).toHaveProperty("documents");
	});

	test("translates API_AUTH_FAILED to agent-safe instruction", async () => {
		pqaSidecar.isRunning = mock(() => true);
		pqaSidecar.start = mock(() => Promise.resolve());
		const err = new Error("api auth failed");
		(err as any).sidecar = {
			error_code: "API_AUTH_FAILED",
			error_message: "API authentication failed",
			error_stage: "startup",
			retryable: false,
		};
		pqaSidecar.call = mock(() => Promise.reject(err));

		const input = { query: "Test", papers: [{ identifier: "10.1234/test" }] };
		const ctx = createMockContext();
		const result = await searchAndAnalyzeTool.execute(input, ctx);

		expect(result.success).toBe(false);
		const errorLower = (result.error ?? "").toLowerCase();
		expect(
			errorLower.includes("api key") || errorLower.includes("authentication"),
		).toBe(true);
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
			const data = result.data as any;
			expect(data?.answer).toContain("Checkpoint inhibitors");
			expect(data?.acquisition_summary.full_text).toContain("36856617");
			expect(data?.acquisition_summary.abstract_only).toHaveLength(0);
			expect(data?.stage_status.query).toBe("success");
			expect(pqaSidecar.call).toHaveBeenCalledTimes(1);
		});

	test("sends documents and prefer_documents flag when both papers and documents are provided", async () => {
		pqaSidecar.isRunning = mock(() => true);
		pqaSidecar.start = mock(() => Promise.resolve());

		pqaSidecar.call = mock(async <T = unknown>(method: string, data: any) => {
			expect(method).toBe("analyze_papers");
			expect(data.prefer_documents).toBe(true);
			expect(data.documents).toHaveLength(1);
			expect(data.papers).toHaveLength(1);
			return {
				answer: "ok",
				references: [],
				context: "",
				stage_status: { acquire: "success", index: "success", query: "success" },
				warnings: [],
			} as unknown as T;
		}) as any;

		const ctx = createMockContext();
		const result = await searchAndAnalyzeTool.execute(
			{
				query: "Test",
				papers: [{ identifier: "36856617" }],
				documents: [
					{
						source_id: "doc-1",
						source_type: "doi",
						provenance_url: "https://example.org/paper",
						retrieval_method: "scrapling_html",
						license_hint: "unknown",
						text: "full text body",
						text_hash: "1234567890abcdef",
						metadata: {},
							extraction_confidence: 0.8,
							extraction_backend: "scrapling",
							fallback_used: false,
							policy: { allowed: true, blocked: false },
						},
					],
			},
			ctx,
		);

		expect(result.success).toBe(true);
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

	// TDD: Cloud model path tests (Issue 9A)
	// These tests specify intended behavior for the PQA_LLM_BACKEND=openrouter cloud path.
	// The Python sidecar validates the API key — the TypeScript layer maps the sidecar
	// error code DEPENDENCY_MISSING to a user-facing failure with an authentication message.

	test("[TDD] PQA_LLM_BACKEND=openrouter without API key returns success=false with auth error", async () => {
		pqaSidecar.isRunning = mock(() => true);
		pqaSidecar.start = mock(() => Promise.resolve());

		// Simulate Python sidecar rejecting due to missing OpenRouter API key.
		const err = new Error("openrouter api key missing");
		(err as any).sidecar = {
			error_code: "DEPENDENCY_MISSING",
			error_message:
				"PQA_LLM_BACKEND=openrouter requires an API key. Set OPENROUTER_API_KEY.",
			error_stage: "startup",
			retryable: false,
		};
		pqaSidecar.call = mock(() => Promise.reject(err));

		const origBackend = process.env.PQA_LLM_BACKEND;
		try {
			process.env.PQA_LLM_BACKEND = "openrouter";

			const ctx = createMockContext();
			const result = await searchAndAnalyzeTool.execute(
				{
					query: "CRISPR therapeutic applications",
					papers: [{ identifier: "10.1234/crispr" }],
				},
				ctx,
			);

			expect(result.success).toBe(false);
			// The error message must mention API key or authentication so the
			// agent knows what remediation is required.
			const errorLower = (result.error ?? "").toLowerCase();
			expect(
				errorLower.includes("api key") || errorLower.includes("authentication"),
			).toBe(true);
		} finally {
			if (origBackend === undefined) {
				delete process.env.PQA_LLM_BACKEND;
			} else {
				process.env.PQA_LLM_BACKEND = origBackend;
			}
		}
	});

	test("[TDD] PQA_LLM_BACKEND=ollama (default) calls sidecar normally", async () => {
		pqaSidecar.isRunning = mock(() => true);
		pqaSidecar.start = mock(() => Promise.resolve());

		pqaSidecar.call = mock(async <T = unknown>(method: string, _data: any) => {
			expect(method).toBe("analyze_papers");
			return {
				answer: "Ollama answered the query.",
				references: [],
				context: "",
				stage_status: {
					acquire: "success",
					index: "success",
					query: "success",
				},
				warnings: [],
			} as unknown as T;
		}) as any;

		const origBackend = process.env.PQA_LLM_BACKEND;
		try {
			// Ollama is the default — ensure existing behavior is preserved.
			process.env.PQA_LLM_BACKEND = "ollama";

			const ctx = createMockContext();
			const result = await searchAndAnalyzeTool.execute(
				{
					query: "KRAS mutation mechanisms",
					papers: [{ identifier: "36856617" }],
				},
				ctx,
			);

			expect(result.success).toBe(true);
			expect(pqaSidecar.call).toHaveBeenCalledTimes(1);
			expect(result.data?.answer).toContain("Ollama answered");
		} finally {
			if (origBackend === undefined) {
				delete process.env.PQA_LLM_BACKEND;
			} else {
				process.env.PQA_LLM_BACKEND = origBackend;
			}
		}
	});
});
