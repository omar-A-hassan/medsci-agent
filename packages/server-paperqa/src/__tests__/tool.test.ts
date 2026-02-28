import { afterEach, describe, expect, mock, test } from "bun:test";
import { createMockContext } from "@medsci/core";
import { pqaSidecar, searchAndAnalyzeTool } from "../tools/search-and-analyze";

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

	test("translates PaperQA explicit python errors to agent-safe instructions via Error Mapper", async () => {
		pqaSidecar.isRunning = mock(() => true);
		pqaSidecar.start = mock(() => Promise.resolve());
		pqaSidecar.call = mock(() =>
			Promise.reject("Traceback... RateLimitExceeded..."),
		);

		const input = { query: "Test", papers: [{ identifier: "10.1234/test" }] };
		const ctx = createMockContext();
		const result = await searchAndAnalyzeTool.execute(input, ctx);

		expect(result.success).toBe(false);
		expect(result.error).toContain(
			"API rate limit reached (likely Semantic Scholar)",
		);
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
