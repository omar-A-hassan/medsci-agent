import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { join } from "node:path";
import {
	type SDKMessage,
	type SessionStats,
	clip,
	extractText,
	findLastByRole,
	readSkillbookForSystem,
	shouldAutoLearn,
} from "./guardrails-helpers";

type ToolBeforeInput = Parameters<NonNullable<Hooks["tool.execute.before"]>>[0];
type ToolBeforeOutput = Parameters<
	NonNullable<Hooks["tool.execute.before"]>
>[1];
type ToolAfterInput = Parameters<NonNullable<Hooks["tool.execute.after"]>>[0];
type ToolAfterOutput = Parameters<NonNullable<Hooks["tool.execute.after"]>>[1];

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const isSensitiveEnvPath = (value: unknown): boolean => {
	if (typeof value !== "string") return false;
	if (value.endsWith(".env.example")) return false;
	return /(^|\/)\.env(\.|$)/.test(value);
};

const isAceTool = (tool: string): boolean => tool.startsWith("ace-mcp.ace.");
const isAceLearningTool = (tool: string): boolean =>
	tool === "ace-mcp.ace.learn.sample" || tool === "ace-mcp.ace.learn.feedback";

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const defaultSessionStats = (): SessionStats => ({
	toolCalls: 0,
	failures: 0,
	aceReads: 0,
	aceWrites: 0,
	sessionLearned: false,
	autoLearnInFlight: false,
});

export const MedsciGuardrailsPlugin: Plugin = async ({ client, directory }) => {
	const startedAt = new Map<string, number>();
	const sessions = new Map<string, SessionStats>();
	/**
	 * Sessions confirmed to be running the medsci agent.
	 * Populated via chat.message (which carries the agent name).
	 * Used to gate system.transform injection to medsci sessions only.
	 */
	const medsciSessions = new Set<string>();

	const skillbookPath = join(
		directory,
		".opencode/ace/skillbooks/medsci_multidomain.json",
	);

	const getSessionStats = (sessionID: string): SessionStats => {
		const existing = sessions.get(sessionID);
		if (existing) return existing;
		const created = defaultSessionStats();
		sessions.set(sessionID, created);
		return created;
	};

	const executionKey = (payload: { sessionID: string; callID: string }) =>
		`${payload.sessionID}:${payload.callID}`;

	return {
		// -----------------------------------------------------------------------
		// Per-task reset — fires when user sends a new message.
		// Also marks sessions running the medsci agent for system transform gating.
		// -----------------------------------------------------------------------
		"chat.message": async (input, _output) => {
			if (input.agent === "medsci") {
				medsciSessions.add(input.sessionID);
			}
			const stats = getSessionStats(input.sessionID);
			stats.toolCalls = 0;
			stats.failures = 0;
			stats.aceReads = 0;
			stats.aceWrites = 0;
			stats.lastTool = undefined;
			stats.lastToolError = undefined;
			stats.lastToolOutputSnippet = undefined;
			stats.sessionLearned = false;
			stats.autoLearnInFlight = false;
		},

		// -----------------------------------------------------------------------
		// Passive skill injection — fires before every LLM call.
		//
		// Only injects for confirmed medsci sessions. Reads the skillbook from
		// disk on every call (the file is small; OS page cache makes this cheap).
		// The medsci model sees learned strategies in its system prompt without
		// needing to call ace.ask — zero model effort required.
		// -----------------------------------------------------------------------
		"experimental.chat.system.transform": async (input, output) => {
			const sid = input.sessionID;
			if (!sid || !medsciSessions.has(sid)) return;
			const skillContext = await readSkillbookForSystem(skillbookPath);
			if (skillContext) {
				output.system.push(skillContext);
			}
		},

		// -----------------------------------------------------------------------
		// Tool execution tracking
		// -----------------------------------------------------------------------
		"tool.execute.before": async (
			input: ToolBeforeInput,
			output: ToolBeforeOutput,
		) => {
			startedAt.set(executionKey(input), Date.now());

			const filePath =
				output.args && typeof output.args === "object"
					? (output.args as Record<string, unknown>).filePath
					: undefined;
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
			const stats = getSessionStats(input.sessionID);
			const key = executionKey(input);
			const start = startedAt.get(key);
			const durationMs =
				typeof start === "number" ? Date.now() - start : undefined;
			startedAt.delete(key);

			const failed =
				output.metadata &&
				typeof output.metadata === "object" &&
				Boolean((output.metadata as Record<string, unknown>).error);
			const aceTool = isAceTool(input.tool);
			const aceLearningWrite = isAceLearningTool(input.tool);

			stats.toolCalls += 1;
			stats.lastTool = input.tool;
			if (failed) stats.failures += 1;
			if (aceTool && !aceLearningWrite) stats.aceReads += 1;
			if (aceLearningWrite) stats.aceWrites += 1;
			if (output.output) stats.lastToolOutputSnippet = clip(output.output, 500);
			if (failed && output.metadata && typeof output.metadata === "object") {
				const err = (output.metadata as Record<string, unknown>).error;
				if (typeof err === "string") stats.lastToolError = clip(err, 400);
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
								"Prefer post-run learning writes after final answer drafting.",
						},
					},
				});
			}
		},

		// -----------------------------------------------------------------------
		// Post-task learning — fires when session goes idle (task complete).
		//
		// WHY session.idle (not experimental.text.complete):
		//   session.idle fires ONCE when the entire agentic loop (all tool calls +
		//   final response) completes. The session is idle at this point, so the
		//   command executes immediately — no QUEUED state.
		//
		// WHY fetch session messages:
		//   ace.learn.feedback needs the actual (question, answer) pair. The
		//   Reflector can only extract meaningful learnings from real task content,
		//   not telemetry alone.
		//
		// WHY agent: "ace":
		//   Routes through the dedicated ace agent — no planning overhead, no
		//   domain tools loaded, ace-mcp calls execute immediately.
		// -----------------------------------------------------------------------
		event: async ({ event }) => {
			if (event.type !== "session.idle") return;

			const { sessionID } = event.properties;
			if (!medsciSessions.has(sessionID)) return;

			const stats = sessions.get(sessionID);
			if (!stats) return;
			if (stats.sessionLearned) return;
			if (stats.autoLearnInFlight) return;
			if (!shouldAutoLearn(stats)) return;

			// Set both flags before any await — prevents double-dispatch if
			// session.idle fires again while we're awaiting (e.g. after ace-learn).
			stats.autoLearnInFlight = true;
			stats.sessionLearned = true;

			try {
				// Fetch real Q/A from session messages for quality learning context
				let question = "(unknown — session messages unavailable)";
				let answer = "(unknown — session messages unavailable)";
				try {
					const msgsResp = await client.session.messages({
						path: { id: sessionID },
					});
					const messages = (msgsResp.data ?? []) as SDKMessage[];
					const lastUser = findLastByRole(messages, "user");
					const lastAsst = findLastByRole(messages, "assistant");
					if (lastUser) question = extractText(lastUser, 1000);
					if (lastAsst) answer = extractText(lastAsst, 1200);
				} catch {
					// Non-fatal: fall back to telemetry-only learning
				}

				const telemetry = [
					`session=${sessionID}`,
					`tool_calls=${stats.toolCalls}`,
					`failures=${stats.failures}`,
					`last_tool=${stats.lastTool ?? "unknown"}`,
					`error=${stats.lastToolError ?? "none"}`,
					`snippet=${clip(stats.lastToolOutputSnippet ?? "", 200)}`,
				].join(" | ");

				// JSON-encode to avoid delimiter collisions in scientific text
				// (SMILES, gene notation, logic symbols can all contain "||" ).
				// The ace agent parses $ARGUMENTS as a JSON object.
				const payload = JSON.stringify({ question, answer, telemetry });

				await client.session.command({
					path: { id: sessionID },
					body: {
						command: "ace-learn",
						agent: "ace",
						arguments: payload,
					},
				});

				await client.app.log({
					body: {
						service: "medsci-ace-guardrails",
						level: "info",
						message: "ace.auto_learn.dispatched_on_idle",
						extra: {
							session_id: sessionID,
							tool_calls: stats.toolCalls,
							failures: stats.failures,
						},
					},
				});
			} catch (error) {
				// Allow retry on next idle (next task completion)
				stats.sessionLearned = false;
				await client.app.log({
					body: {
						service: "medsci-ace-guardrails",
						level: "warn",
						message: "ace.auto_learn.dispatch_failed",
						extra: { session_id: sessionID, error: String(error) },
					},
				});
			} finally {
				stats.autoLearnInFlight = false;
			}
		},
	};
};
