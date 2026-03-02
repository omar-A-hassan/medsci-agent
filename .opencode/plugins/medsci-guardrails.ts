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

export const MedsciGuardrailsPlugin: Plugin = async ({ client }) => {
	const startedAt = new Map<string, number>();

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
			const key = executionKey(input);
			const start = startedAt.get(key);
			const durationMs =
				typeof start === "number" ? Date.now() - start : undefined;
			startedAt.delete(key);
			const failed = outputHasError(output);

			await client.app.log({
				body: {
					service: "medsci-guardrails",
					level: failed ? "warn" : "info",
					message: "tool.execute",
					extra: {
						tool: input.tool,
						session_id: input.sessionID,
						duration_ms: durationMs,
						failed,
					},
				},
			});
		},
	};
};
