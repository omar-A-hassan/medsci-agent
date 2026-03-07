import type { Hooks, Plugin } from "@opencode-ai/plugin";

type ToolBeforeInput = Parameters<NonNullable<Hooks["tool.execute.before"]>>[0];
type ToolBeforeOutput = Parameters<
	NonNullable<Hooks["tool.execute.before"]>
>[1];
type ToolAfterInput = Parameters<NonNullable<Hooks["tool.execute.after"]>>[0];
type ToolAfterOutput = Parameters<NonNullable<Hooks["tool.execute.after"]>>[1];

const isSensitiveEnvPath = (value: unknown): boolean => {
	if (typeof value !== "string") {
		return false;
	}
	if (value.endsWith(".env.example")) {
		return false;
	}
	return /(^|\/)\.env(\.|$)/.test(value);
};

const executionKey = (payload: {
	sessionID: string;
	callID: string;
}): string => {
	const sessionPart = payload.sessionID;
	const idPart = payload.callID;
	return `${sessionPart}:${idPart}`;
};

const getArgValue = (args: unknown, key: string): unknown => {
	if (!args || typeof args !== "object") {
		return undefined;
	}
	return (args as Record<string, unknown>)[key];
};

const outputHasError = (output: ToolAfterOutput): boolean => {
	if (!output.metadata || typeof output.metadata !== "object") {
		return false;
	}
	return Boolean((output.metadata as Record<string, unknown>).error);
};

const isAceTool = (tool: string): boolean => tool.startsWith("ace-mcp.ace.");

const isAceLearningTool = (tool: string): boolean =>
	tool === "ace-mcp.ace.learn.sample" || tool === "ace-mcp.ace.learn.feedback";

type SessionStats = {
	toolCalls: number;
	failures: number;
	aceReads: number;
	aceWrites: number;
	lastTool?: string;
	lastToolError?: string;
	lastToolOutputSnippet?: string;
	learnedForMessageIDs: Set<string>;
	autoLearnSuppressedMessageIDs: Set<string>;
	autoLearnInFlight: boolean;
};

const clip = (value: string, max = 500): string =>
	value.length <= max ? value : `${value.slice(0, max)}...`;

const defaultSessionStats = (): SessionStats => ({
	toolCalls: 0,
	failures: 0,
	aceReads: 0,
	aceWrites: 0,
	learnedForMessageIDs: new Set<string>(),
	autoLearnSuppressedMessageIDs: new Set<string>(),
	autoLearnInFlight: false,
});

const shouldAutoLearn = (stats: SessionStats): boolean => {
	if (stats.toolCalls === 0) {
		return false;
	}
	if (stats.aceWrites > 0) {
		return false;
	}
	if (stats.failures > 0) {
		return true;
	}
	if (!stats.lastToolOutputSnippet) {
		return false;
	}
	return stats.toolCalls >= 2;
};

const buildAutoLearnSummary = (sessionID: string, stats: SessionStats): string => {
	const answer = [
		"Run completed. Auto-learning snapshot generated from tool telemetry.",
		`Session: ${sessionID}`,
		`Tool calls: ${stats.toolCalls}`,
		`Failures: ${stats.failures}`,
		`Last tool: ${stats.lastTool ?? "unknown"}`,
		stats.lastToolOutputSnippet
			? `Last tool snippet: ${clip(stats.lastToolOutputSnippet, 300)}`
			: "No tool output snippet captured.",
	]
		.filter(Boolean)
		.join("\n");
	return answer;
};

export const MedsciGuardrailsPlugin: Plugin = async ({ client }) => {
	const startedAt = new Map<string, number>();
	const sessions = new Map<string, SessionStats>();

	const getSessionStats = (sessionID: string): SessionStats => {
		const existing = sessions.get(sessionID);
		if (existing) {
			return existing;
		}
		const created = defaultSessionStats();
		sessions.set(sessionID, created);
		return created;
	};

	return {
		"tool.execute.before": async (
			input: ToolBeforeInput,
			output: ToolBeforeOutput,
		) => {
			const key = executionKey(input);
			startedAt.set(key, Date.now());

			const filePath = getArgValue(output.args, "filePath");
			if (input.tool === "read" && isSensitiveEnvPath(filePath)) {
				throw new Error(
					"Reading .env files is blocked by medsci-guardrails plugin.",
				);
			}
		},
		"tool.execute.after": async (
			input: ToolAfterInput,
			output: ToolAfterOutput,
		) => {
			const sessionStats = getSessionStats(input.sessionID);
			const key = executionKey(input);
			const start = startedAt.get(key);
			const durationMs =
				typeof start === "number" ? Date.now() - start : undefined;
			startedAt.delete(key);
			const failed = outputHasError(output);
			const aceTool = isAceTool(input.tool);
			const aceLearningWrite = isAceLearningTool(input.tool);
			sessionStats.toolCalls += 1;
			sessionStats.lastTool = input.tool;
			if (failed) {
				sessionStats.failures += 1;
			}
			if (aceTool && !aceLearningWrite) {
				sessionStats.aceReads += 1;
			}
			if (aceLearningWrite) {
				sessionStats.aceWrites += 1;
			}
			if (output.output) {
				sessionStats.lastToolOutputSnippet = clip(output.output, 500);
			}
			if (failed && output.metadata && typeof output.metadata === "object") {
				const err = (output.metadata as Record<string, unknown>).error;
				if (typeof err === "string") {
					sessionStats.lastToolError = clip(err, 400);
				}
			}

			await client.app.log({
				body: {
					service: aceTool ? "medsci-ace-guardrails" : "medsci-guardrails",
					level: failed ? "warn" : "info",
					message: "tool.execute",
					extra: {
						tool: input.tool,
						session_id: input.sessionID,
						duration_ms: durationMs,
						failed,
						ace_tool: aceTool,
						ace_learning_write: aceLearningWrite,
					},
				},
			});

			if (aceLearningWrite) {
				await client.app.log({
					body: {
						service: "medsci-ace-guardrails",
						level: "warn",
						message: "ace.learning.write_called",
						extra: {
							tool: input.tool,
							session_id: input.sessionID,
							advice:
								"Prefer post-run learning writes after final answer drafting for reproducibility.",
						},
					},
				});
			}
		},
		"experimental.text.complete": async (input, _output) => {
			const sessionStats = getSessionStats(input.sessionID);

			if (sessionStats.autoLearnSuppressedMessageIDs.has(input.messageID)) {
				sessionStats.autoLearnSuppressedMessageIDs.delete(input.messageID);
				return;
			}

			if (sessionStats.autoLearnInFlight) {
				return;
			}

			if (sessionStats.learnedForMessageIDs.has(input.messageID)) {
				return;
			}

			if (!shouldAutoLearn(sessionStats)) {
				await client.app.log({
					body: {
						service: "medsci-ace-guardrails",
						level: "info",
						message: "ace.auto_learn.skipped",
						extra: {
							session_id: input.sessionID,
							message_id: input.messageID,
							tool_calls: sessionStats.toolCalls,
							failures: sessionStats.failures,
							ace_writes: sessionStats.aceWrites,
						},
					},
				});
				return;
			}

			const summary = buildAutoLearnSummary(input.sessionID, sessionStats);

			try {
				sessionStats.autoLearnInFlight = true;

				const commandResp = await client.session.command({
					path: {
						id: input.sessionID,
					},
					body: {
						command: "ace-learn",
						arguments: [
							`session=${input.sessionID}`,
							`tool_calls=${sessionStats.toolCalls}`,
							`failures=${sessionStats.failures}`,
							`last_tool=${sessionStats.lastTool ?? "unknown"}`,
							`error=${sessionStats.lastToolError ?? "none"}`,
							`output=${summary}`,
						].join(" | "),
					},
				});
				const autoLearnMessageID = commandResp.data?.info?.id;
				if (autoLearnMessageID) {
					sessionStats.autoLearnSuppressedMessageIDs.add(autoLearnMessageID);
				}

				sessionStats.learnedForMessageIDs.add(input.messageID);

				await client.app.log({
					body: {
						service: "medsci-ace-guardrails",
						level: "info",
						message: "ace.auto_learn.completed",
						extra: {
							session_id: input.sessionID,
							message_id: input.messageID,
							tool_calls: sessionStats.toolCalls,
							failures: sessionStats.failures,
							auto_learn_command_ok: Boolean(commandResp.data),
							auto_learn_message_id: autoLearnMessageID,
						},
					},
				});
			} catch (error) {
				await client.app.log({
					body: {
						service: "medsci-ace-guardrails",
						level: "warn",
						message: "ace.auto_learn.failed",
						extra: {
							session_id: input.sessionID,
							message_id: input.messageID,
							error: String(error),
						},
					},
				});
			} finally {
				sessionStats.autoLearnInFlight = false;
			}
		},
	};
};
