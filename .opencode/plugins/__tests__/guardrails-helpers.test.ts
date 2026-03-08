import { describe, expect, test } from "bun:test";
import {
	type SDKMessage,
	type SessionStats,
	clip,
	extractText,
	findLastByRole,
	readSkillbookForSystem,
	shouldAutoLearn,
} from "../guardrails-helpers";

// ---------------------------------------------------------------------------
// clip
// ---------------------------------------------------------------------------

describe("clip", () => {
	test("returns value unchanged when under limit", () => {
		expect(clip("hello", 10)).toBe("hello");
	});

	test("clips and appends ellipsis when over limit", () => {
		const result = clip("abcdefgh", 5);
		expect(result).toBe("abcde...");
		expect(result.length).toBe(8);
	});

	test("clips at exactly the limit boundary", () => {
		expect(clip("abcde", 5)).toBe("abcde");
		expect(clip("abcdef", 5)).toBe("abcde...");
	});

	test("uses default max=500", () => {
		const long = "x".repeat(600);
		const result = clip(long);
		expect(result.length).toBe(503); // 500 + "..."
		expect(result.endsWith("...")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// shouldAutoLearn
// ---------------------------------------------------------------------------

const baseStats = (): SessionStats => ({
	toolCalls: 0,
	failures: 0,
	aceReads: 0,
	aceWrites: 0,
	lastToolOutputSnippet: "some output",
	sessionLearned: false,
	autoLearnInFlight: false,
});

describe("shouldAutoLearn", () => {
	test("returns false when toolCalls < 2", () => {
		expect(shouldAutoLearn({ ...baseStats(), toolCalls: 0 })).toBe(false);
		expect(shouldAutoLearn({ ...baseStats(), toolCalls: 1 })).toBe(false);
	});

	test("returns true when toolCalls >= 2 with output snippet", () => {
		expect(shouldAutoLearn({ ...baseStats(), toolCalls: 2 })).toBe(true);
		expect(shouldAutoLearn({ ...baseStats(), toolCalls: 10 })).toBe(true);
	});

	test("returns false when aceWrites > 0 (manual learn already ran)", () => {
		expect(
			shouldAutoLearn({ ...baseStats(), toolCalls: 5, aceWrites: 1 }),
		).toBe(false);
	});

	test("returns false when no lastToolOutputSnippet", () => {
		expect(
			shouldAutoLearn({
				...baseStats(),
				toolCalls: 3,
				lastToolOutputSnippet: undefined,
			}),
		).toBe(false);
	});

	test("failures alone do not suppress learning", () => {
		expect(
			shouldAutoLearn({ ...baseStats(), toolCalls: 3, failures: 2 }),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// extractText
// ---------------------------------------------------------------------------

describe("extractText", () => {
	const msg = (parts: Array<{ type: string; text?: string }>): SDKMessage => ({
		info: { role: "user" },
		parts,
	});

	test("concatenates text parts", () => {
		const result = extractText(
			msg([
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
			]),
		);
		expect(result).toBe("hello\nworld");
	});

	test("ignores non-text parts", () => {
		const result = extractText(
			msg([
				{ type: "tool_call", text: "ignored" },
				{ type: "text", text: "kept" },
				{ type: "reasoning" },
			]),
		);
		expect(result).toBe("kept");
	});

	test("returns empty string when no text parts", () => {
		expect(extractText(msg([{ type: "tool_call" }]))).toBe("");
		expect(extractText(msg([]))).toBe("");
	});

	test("clips to maxChars", () => {
		const result = extractText(
			msg([{ type: "text", text: "a".repeat(2000) }]),
			100,
		);
		expect(result).toBe("a".repeat(100));
	});

	test("uses default maxChars=1200", () => {
		const result = extractText(
			msg([{ type: "text", text: "b".repeat(2000) }]),
		);
		expect(result).toHaveLength(1200);
	});
});

// ---------------------------------------------------------------------------
// findLastByRole
// ---------------------------------------------------------------------------

describe("findLastByRole", () => {
	const makeMsg = (role: string): SDKMessage => ({
		info: { role },
		parts: [{ type: "text", text: role }],
	});

	test("returns undefined for empty array", () => {
		expect(findLastByRole([], "user")).toBeUndefined();
	});

	test("returns undefined when role not present", () => {
		expect(findLastByRole([makeMsg("assistant")], "user")).toBeUndefined();
	});

	test("returns the only matching message", () => {
		const msg = makeMsg("user");
		expect(findLastByRole([msg], "user")).toBe(msg);
	});

	test("returns the LAST matching message (not the first)", () => {
		const first = makeMsg("user");
		const second = makeMsg("assistant");
		const last = makeMsg("user");
		expect(findLastByRole([first, second, last], "user")).toBe(last);
	});

	test("handles alternating roles correctly", () => {
		const msgs = [
			makeMsg("user"),
			makeMsg("assistant"),
			makeMsg("user"),
			makeMsg("assistant"),
		];
		expect(findLastByRole(msgs, "assistant")).toBe(msgs[3]);
		expect(findLastByRole(msgs, "user")).toBe(msgs[2]);
	});
});

// ---------------------------------------------------------------------------
// readSkillbookForSystem
// ---------------------------------------------------------------------------

describe("readSkillbookForSystem", () => {
	const makeReadFn =
		(content: string) =>
		async (_path: string, _enc: "utf-8"): Promise<string> =>
			content;

	const makeThrowFn =
		(err: Error) =>
		async (_path: string, _enc: "utf-8"): Promise<string> => {
			throw err;
		};

	test("returns empty string when file not found", async () => {
		const result = await readSkillbookForSystem(
			"/nonexistent/path.json",
			makeThrowFn(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
		);
		expect(result).toBe("");
	});

	test("returns empty string when JSON is invalid", async () => {
		const result = await readSkillbookForSystem(
			"/path.json",
			makeReadFn("not valid json {{"),
		);
		expect(result).toBe("");
	});

	test("returns empty string when skills object is empty", async () => {
		const result = await readSkillbookForSystem(
			"/path.json",
			makeReadFn(JSON.stringify({ skills: {}, sections: {}, next_id: 0 })),
		);
		expect(result).toBe("");
	});

	test("returns empty string when all skills are invalid status", async () => {
		const data = {
			skills: {
				"drug-00001": {
					id: "drug-00001",
					section: "drug-search",
					content: "Use molecule search",
					helpful: 3,
					harmful: 0,
					neutral: 0,
					status: "invalid",
				},
			},
		};
		const result = await readSkillbookForSystem(
			"/path.json",
			makeReadFn(JSON.stringify(data)),
		);
		expect(result).toBe("");
	});

	test("formats active skills into system context block", async () => {
		const data = {
			skills: {
				"drug-00001": {
					id: "drug-00001",
					section: "drug-search",
					content: "Use search_type=molecule for ChEMBL inhibitor queries",
					helpful: 3,
					harmful: 0,
					neutral: 0,
					status: "active",
				},
			},
		};
		const result = await readSkillbookForSystem(
			"/path.json",
			makeReadFn(JSON.stringify(data)),
		);
		expect(result).toContain("## Learned Strategic Knowledge");
		expect(result).toContain("[drug-00001]");
		expect(result).toContain("drug-search");
		expect(result).toContain("+3/-0");
		expect(result).toContain("Use search_type=molecule for ChEMBL inhibitor queries");
	});

	test("sorts skills by net helpfulness descending", async () => {
		const data = {
			skills: {
				"skill-low": {
					id: "skill-low",
					section: "general",
					content: "Low confidence strategy",
					helpful: 1,
					harmful: 1,
					neutral: 0,
					status: "active",
				},
				"skill-high": {
					id: "skill-high",
					section: "general",
					content: "High confidence strategy",
					helpful: 5,
					harmful: 0,
					neutral: 0,
					status: "active",
				},
			},
		};
		const result = await readSkillbookForSystem(
			"/path.json",
			makeReadFn(JSON.stringify(data)),
		);
		const highIdx = result.indexOf("skill-high");
		const lowIdx = result.indexOf("skill-low");
		expect(highIdx).toBeLessThan(lowIdx); // high confidence listed first
	});

	test("caps output at 15 skills", async () => {
		const skills: Record<string, object> = {};
		for (let i = 0; i < 20; i++) {
			const id = `skill-${String(i).padStart(5, "0")}`;
			skills[id] = {
				id,
				section: "test",
				content: `Strategy ${i}`,
				helpful: i,
				harmful: 0,
				neutral: 0,
				status: "active",
			};
		}
		const result = await readSkillbookForSystem(
			"/path.json",
			makeReadFn(JSON.stringify({ skills })),
		);
		// Count bracket-prefixed skill lines
		const skillLines = result
			.split("\n")
			.filter((l) => l.startsWith("[skill-"));
		expect(skillLines).toHaveLength(15);
	});

	test("excludes invalid-status skills from output", async () => {
		const data = {
			skills: {
				"active-skill": {
					id: "active-skill",
					section: "general",
					content: "Active strategy",
					helpful: 2,
					harmful: 0,
					neutral: 0,
					status: "active",
				},
				"invalid-skill": {
					id: "invalid-skill",
					section: "general",
					content: "Invalid strategy",
					helpful: 10,
					harmful: 0,
					neutral: 0,
					status: "invalid",
				},
			},
		};
		const result = await readSkillbookForSystem(
			"/path.json",
			makeReadFn(JSON.stringify(data)),
		);
		expect(result).toContain("active-skill");
		expect(result).not.toContain("invalid-skill");
	});
});
