import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "./config";
import { createLogger } from "./logger";
import { OllamaClient } from "./models/ollama";
import { PythonSidecar } from "./models/python-sidecar";
import type { ToolContext, ToolDefinition } from "./types";

/**
 * Creates a fully wired MCP server from an array of ToolDefinitions.
 * Handles:
 *  - Config resolution & hardware profiles
 *  - Ollama and Python sidecar initialization
 *  - Tool registration on the MCP server
 *  - Graceful shutdown
 *
 * Usage in each server's index.ts:
 *   import { createMcpServer } from "@medsci/core";
 *   import { tools } from "./tools";
 *   await createMcpServer({ name: "medsci-drug", version: "0.1.0", tools });
 */
export async function createMcpServer(opts: {
	name: string;
	version: string;
	tools: ToolDefinition<any, any>[];
}) {
	const config = resolveConfig();
	const log = createLogger(opts.name);

	// --- Initialize Ollama model client ---
	const modelClient = new OllamaClient({
		baseUrl: config.ollama.baseUrl,
		defaultModel: config.ollama.defaultModel,
		timeoutMs: config.ollama.timeoutMs,
	});
	log.info(
		`using Ollama at ${config.ollama.baseUrl} (model: ${config.ollama.defaultModel})`,
	);

	const preload =
		config.profileConfig.pythonPreload === "all"
			? [] // sidecar.py handles "all" itself
			: config.profileConfig.pythonPreload;

	const python = new PythonSidecar({
		preloadLibs: preload,
		timeoutMs: config.python.timeoutMs,
	});

	const ctx: ToolContext = { ollama: modelClient, python, log };

	// --- Build MCP server ---
	const server = new McpServer({
		name: opts.name,
		version: opts.version,
	});

	// Unwrap ZodEffects (from .superRefine/.refine/.transform) to reach the underlying
	// ZodObject. Without this, schemas wrapped by these operators have no .shape, causing
	// the MCP SDK to register the tool with an empty parameter schema. Zod's default
	// strip mode then removes all incoming args, producing "field: Required" errors.
	function unwrapZodShape(s: any): Record<string, any> {
		if (s && "shape" in s) return s.shape;
		const inner = s?._def?.innerType ?? s?._def?.schema;
		return inner ? unwrapZodShape(inner) : {};
	}

	// Register each tool — pass the raw Zod .shape so McpServer gets real Zod types
	for (const tool of opts.tools) {
		const zodShape = unwrapZodShape(tool.schema);
		if (Object.keys(zodShape).length === 0) {
			log.warn(`[${tool.name}] schema has no .shape — parameters will not be exposed to MCP callers`);
		}

		server.tool(tool.name, tool.description, zodShape, async (args: any) => {
			const result = await tool.execute(args as any, ctx);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		});
	}

	// --- Connect transport & handle shutdown ---
	const transport = new StdioServerTransport();

	const shutdown = async () => {
		log.info("shutting down");
		await python.stop();
		await server.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	log.info(`starting ${opts.name} v${opts.version}`);
	await server.connect(transport);
}
