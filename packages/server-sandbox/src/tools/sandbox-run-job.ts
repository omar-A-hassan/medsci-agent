import { defineTool } from "@medsci/core";
import { z } from "zod";
import { DockerSandboxBackend } from "../backend/docker-sandbox-backend";

const backend = new DockerSandboxBackend();

export const sandboxRunJob = defineTool({
	name: "sandbox_run_job",
	description:
		"Execute a command in an existing Docker sandbox and capture stdout, stderr, exit code, duration, and artifact metadata. Synchronous execution only.",
	schema: z.object({
		sandbox_name: z
			.string()
			.min(1)
			.describe("Name of the sandbox to execute in"),
		job_id: z
			.string()
			.optional()
			.describe("Optional job identifier; auto-generated if omitted"),
		command: z
			.string()
			.min(1)
			.describe("Shell command to execute inside the sandbox"),
		workdir: z
			.string()
			.optional()
			.describe("Working directory inside the sandbox"),
		env: z
			.record(z.string())
			.optional()
			.describe("Environment variables to set for the command"),
		timeout_sec: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Hard timeout in seconds (default: 600, max: 3600)"),
		expected_artifacts: z
			.array(z.string())
			.optional()
			.describe("Glob-like paths of expected output artifacts to verify"),
		artifact_root: z
			.string()
			.optional()
			.describe(
				"Root directory for job artifacts (default: <workspace>/sandbox-artifacts)",
			),
	}),
	execute: async (input, ctx) => {
		ctx.log.info(
			`[sandbox_run_job] sandbox=${input.sandbox_name} command=${input.command.slice(0, 80)}`,
		);
		try {
			const result = await backend.runJob(input);
			ctx.log.info(
				`[sandbox_run_job] done: exit=${result.exit_code} duration=${result.duration_ms}ms`,
			);
			return { success: true, data: result };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			ctx.log.error(`[sandbox_run_job] failed: ${message}`);
			return { success: false, error: message };
		}
	},
});
