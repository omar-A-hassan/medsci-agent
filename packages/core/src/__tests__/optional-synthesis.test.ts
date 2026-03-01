import { describe, expect, test } from "bun:test";
import { withOptionalSynthesis } from "../optional-synthesis";

describe("withOptionalSynthesis", () => {
	test("returns raw payload with model_used=false when synthesis is disabled", async () => {
		const data = await withOptionalSynthesis(
			false,
			{ key: "value" },
			async () => ({ interpretation: "should not run", model_used: true }),
		);

		expect(data).toEqual({
			key: "value",
			interpretation: "",
			model_used: false,
		});
	});

	test("merges interpretation when synthesis is enabled", async () => {
		const data = await withOptionalSynthesis(
			true,
			{ count: 2 },
			async () => ({ interpretation: "summary", model_used: true }),
		);

		expect(data).toEqual({
			count: 2,
			interpretation: "summary",
			model_used: true,
		});
	});
});
