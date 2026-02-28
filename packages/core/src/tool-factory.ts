import type { z } from "zod";
import type { ToolContext, ToolDefinition, ToolResult } from "./types";

/**
 * Factory for creating MCP tools with consistent validation, error handling,
 * and timing. Every tool defined through this factory gets:
 *
 * 1. Zod schema validation on input
 * 2. Structured error wrapping (no unhandled throws)
 * 3. Duration tracking
 * 4. Logging (start, success, failure)
 *
 * Usage:
 *   const myTool = defineTool({
 *     name: "predict_toxicity",
 *     description: "Predict compound toxicity",
 *     schema: z.object({ smiles: z.string().min(1) }),
 *     execute: async (input, ctx) => {
 *       const result = await ctx.python.call("rdkit.lipinski_filter", { smiles: input.smiles });
 *       return { success: true, data: result };
 *     },
 *   });
 */
export function defineTool<TInput, TOutput>(config: {
	name: string;
	description: string;
	schema: z.ZodType<TInput>;
	execute: (input: TInput, ctx: ToolContext) => Promise<ToolResult<TOutput>>;
}): ToolDefinition<TInput, TOutput> {
	return {
		name: config.name,
		description: config.description,
		schema: config.schema,
		execute: async (
			rawInput: TInput,
			ctx: ToolContext,
		): Promise<ToolResult<TOutput>> => {
			const start = performance.now();

			// --- Validate input ---
			const parsed = config.schema.safeParse(rawInput);
			if (!parsed.success) {
				const issues = parsed.error.issues
					.map((i) => `${i.path.join(".")}: ${i.message}`)
					.join("; ");
				ctx.log.warn(`[${config.name}] validation failed: ${issues}`);
				return {
					success: false,
					error: `Invalid input: ${issues}`,
					duration_ms: performance.now() - start,
				};
			}

			// --- Execute ---
			try {
				ctx.log.info(`[${config.name}] executing`);
				const result = await config.execute(parsed.data, ctx);
				const duration_ms = performance.now() - start;
				ctx.log.info(
					`[${config.name}] completed in ${duration_ms.toFixed(0)}ms`,
				);
				return { ...result, duration_ms };
			} catch (err) {
				const duration_ms = performance.now() - start;
				const message = err instanceof Error ? err.message : String(err);
				ctx.log.error(`[${config.name}] failed: ${message}`);
				return { success: false, error: message, duration_ms };
			}
		},
	};
}
