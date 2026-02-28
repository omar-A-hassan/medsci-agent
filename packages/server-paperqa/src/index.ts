import { createLogger, createMcpServer } from "@medsci/core";
import { searchAndAnalyzeTool } from "./tools/search-and-analyze";

const logger = createLogger("server-paperqa", "info");

async function main() {
	logger.info("Starting PaperQA2 MCP Server...");

	// createMcpServer initializes and connects stdio transport internally
	await createMcpServer({
		name: "server-paperqa",
		version: "1.0.0",
		tools: [searchAndAnalyzeTool],
	});
}

if (import.meta.main) {
	main().catch((err) => {
		logger.error("Fatal error starting server:", err);
		process.exit(1);
	});
}
