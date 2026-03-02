import { defineTool } from "@medsci/core";
import { z } from "zod";
import { DockerSandboxBackend } from "../backend/docker-sandbox-backend";

const backend = new DockerSandboxBackend();

export const sandboxFetchArtifact = defineTool({
	name: "sandbox_fetch_artifact",
	description:
		"Read a generated artifact or log file from the host-visible workspace path. Enforces path safety checks and size limits.",
	schema: z.object({
		sandbox_name: z
			.string()
			.min(1)
			.describe("Name of the sandbox the artifact belongs to"),
		artifact_path: z
			.string()
			.min(1)
			.describe("Absolute or workspace-relative path to the artifact"),
		encoding: z
			.enum(["utf8", "base64"])
			.optional()
			.describe("Encoding for the returned content (default: utf8)"),
		max_bytes: z
			.number()
			.int()
			.positive()
			.optional()
			.describe(
				"Maximum bytes to read (default: 1 MB, max: 10 MB). Content is truncated beyond this.",
			),
	}),
	execute: async (input, ctx) => {
		ctx.log.info(
			`[sandbox_fetch_artifact] sandbox=${input.sandbox_name} path=${input.artifact_path}`,
		);
		try {
			const result = await backend.fetchArtifact(input);
			ctx.log.info(
				`[sandbox_fetch_artifact] done: size=${result.size_bytes} truncated=${result.truncated}`,
			);
			return { success: true, data: result };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			ctx.log.error(`[sandbox_fetch_artifact] failed: ${message}`);
			return { success: false, error: message };
		}
	},
});
