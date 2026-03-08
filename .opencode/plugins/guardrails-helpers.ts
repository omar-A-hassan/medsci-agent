/**
 * Pure helper functions for medsci-guardrails plugin.
 * Exported separately so they can be unit-tested without the OpenCode runtime.
 */

import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SkillEntry = {
	id: string;
	section: string;
	content: string;
	helpful: number;
	harmful: number;
	neutral: number;
	status?: string;
};

export type SkillbookFile = {
	skills: Record<string, SkillEntry>;
};

export type SDKMessage = {
	info: { role: string };
	parts: Array<{ type: string; text?: string }>;
};

export type SessionStats = {
	toolCalls: number;
	failures: number;
	aceReads: number;
	aceWrites: number;
	lastTool?: string;
	lastToolError?: string;
	lastToolOutputSnippet?: string;
	sessionLearned: boolean;
	autoLearnInFlight: boolean;
};

// ---------------------------------------------------------------------------
// Skillbook injection
// ---------------------------------------------------------------------------

/**
 * Read and format the skillbook for system prompt injection.
 * Returns empty string if the file is missing, empty, or unparseable.
 * Never throws — always safe to call.
 */
export async function readSkillbookForSystem(
	skillbookPath: string,
	readFileFn: (p: string, enc: "utf-8") => Promise<string> = readFile,
): Promise<string> {
	try {
		const raw = await readFileFn(skillbookPath, "utf-8");
		const data = JSON.parse(raw) as SkillbookFile;
		const entries = Object.entries(data.skills ?? {});
		if (entries.length === 0) return "";

		// Top 15 active skills by net helpfulness score
		const active = entries
			.filter(([, s]) => s.status !== "invalid")
			.sort(
				([, a], [, b]) =>
					b.helpful - b.harmful - (a.helpful - a.harmful),
			)
			.slice(0, 15);

		if (active.length === 0) return "";

		const lines = active.map(
			([id, s]) =>
				`[${id}] (${s.section}, +${s.helpful}/-${s.harmful}) ${s.content}`,
		);

		return [
			"## Learned Strategic Knowledge (from previous MedSci tasks)",
			"",
			"The following strategies were distilled from past executions.",
			"When a strategy matches your situation, cite its ID in your reasoning",
			'(e.g. "Following [drug-00001], I will use search_type=\'molecule\'").',
			"Prioritise skills with higher helpful/harmful ratio. Use judgment — patterns not rigid rules.",
			"",
			...lines,
		].join("\n");
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Session message extraction
// ---------------------------------------------------------------------------

/** Extract plain text from text parts of a message, clipped to maxChars. */
export function extractText(msg: SDKMessage, maxChars = 1200): string {
	return msg.parts
		.filter((p) => p.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string)
		.join("\n")
		.slice(0, maxChars);
}

/** Return the last message with the given role, searching backwards. */
export function findLastByRole(
	messages: SDKMessage[],
	role: "user" | "assistant",
): SDKMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].info.role === role) return messages[i];
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Auto-learn gate
// ---------------------------------------------------------------------------

/**
 * Returns true when there is enough evidence to trigger ACE learning.
 * Called only AFTER session.idle — timing is guaranteed by the event hook.
 */
export function shouldAutoLearn(stats: SessionStats): boolean {
	if (stats.toolCalls < 2) return false;
	// aceWrites > 0 means manual /ace-learn already ran for this task
	if (stats.aceWrites > 0) return false;
	if (!stats.lastToolOutputSnippet) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export const clip = (value: string, max = 500): string =>
	value.length <= max ? value : `${value.slice(0, max)}...`;
