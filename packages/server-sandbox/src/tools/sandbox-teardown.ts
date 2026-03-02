import { defineTool } from "@medsci/core";
import { z } from "zod";
import { DockerSandboxBackend } from "../backend/docker-sandbox-backend";

const backend = new DockerSandboxBackend();

export const sandboxTeardown = defineTool({
	name: "sandbox_teardown",
	description:
		"Stop or remove a Docker sandbox. By default only stops; set remove to true to also delete.",
	schema: z.object({
		sandbox_name: z
			.string()
			.min(1)
			.describe("Name of the sandbox to tear down"),
		remove: z
			.boolean()
			.optional()
			.describe("If true, remove the sandbox after stopping (default: false)"),
	}),
	execute: async (input, ctx) => {
		ctx.log.info(
			`[sandbox_teardown] sandbox=${input.sandbox_name} remove=${input.remove ?? false}`,
		);
		try {
			const result = await backend.teardown(input);
			ctx.log.info(
				`[sandbox_teardown] done: stopped=${result.stopped} removed=${result.removed}`,
			);
			return { success: true, data: result };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			ctx.log.error(`[sandbox_teardown] failed: ${message}`);
			return { success: false, error: message };
		}
	},
});
