import { defineTool } from "@medsci/core";
import { z } from "zod";
import { DockerSandboxBackend } from "../backend/docker-sandbox-backend";

const backend = new DockerSandboxBackend();

export const sandboxPrepare = defineTool({
	name: "sandbox_prepare",
	description:
		"Create or verify an isolated Docker sandbox for the workspace. Optionally apply a container template and network policy. Idempotent — returns existing sandbox info if already created.",
	schema: z.object({
		workspace_path: z
			.string()
			.min(1)
			.describe("Absolute host path to the workspace directory"),
		sandbox_name: z
			.string()
			.optional()
			.describe("Explicit sandbox name; auto-generated if omitted"),
		template: z
			.string()
			.optional()
			.describe("Docker image template for the sandbox"),
		pull_template: z
			.enum(["missing", "always", "never"])
			.optional()
			.describe("Template pull policy: missing (default), always, or never"),
		extra_workspaces: z
			.array(
				z.object({
					path: z.string().describe("Absolute host path to mount"),
					read_only: z
						.boolean()
						.optional()
						.describe("Mount as read-only if true"),
				}),
			)
			.optional()
			.describe("Additional workspace paths to mount in the sandbox"),
		network_policy: z
			.enum(["deny", "allow"])
			.optional()
			.describe("Network policy: deny (default) or allow"),
		allow_hosts: z
			.array(z.string())
			.optional()
			.describe("Hosts to allow when network_policy is allow"),
	}),
	execute: async (input, ctx) => {
		ctx.log.info(
			`[sandbox_prepare] workspace=${input.workspace_path} name=${input.sandbox_name ?? "auto"}`,
		);
		try {
			const result = await backend.prepare(input);
			ctx.log.info(
				`[sandbox_prepare] done: created=${result.created} status=${result.status}`,
			);
			return { success: true, data: result };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			ctx.log.error(`[sandbox_prepare] failed: ${message}`);
			return { success: false, error: message };
		}
	},
});
