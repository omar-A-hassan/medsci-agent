import { defineTool } from "@medsci/core";
import { z } from "zod";
import { DockerSandboxBackend } from "../backend/docker-sandbox-backend";

const backend = new DockerSandboxBackend();

export const sandboxStatus = defineTool({
	name: "sandbox_status",
	description:
		"Return the high-level state of a Docker sandbox (exists, running, or stopped).",
	schema: z.object({
		sandbox_name: z.string().min(1).describe("Name of the sandbox to query"),
	}),
	execute: async (input, ctx) => {
		ctx.log.info(`[sandbox_status] sandbox=${input.sandbox_name}`);
		try {
			const result = await backend.status(input);
			ctx.log.info(
				`[sandbox_status] done: exists=${result.exists} status=${result.status}`,
			);
			return { success: true, data: result };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			ctx.log.error(`[sandbox_status] failed: ${message}`);
			return { success: false, error: message };
		}
	},
});
