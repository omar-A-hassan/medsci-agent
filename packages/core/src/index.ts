// @medsci/core — shared infrastructure for all MCP servers

export { defineTool } from "./tool-factory";
export { createMcpServer } from "./server-factory";
export { OllamaClient } from "./models/ollama";
export { PythonSidecar } from "./models/python-sidecar";
export { resolvePythonSidecarOptions } from "./models/python-sidecar-bootstrap";
export type {
	PythonSidecarOptions,
	ResolvedPythonSidecarOptions,
} from "./models/python-sidecar-bootstrap";
export { createLogger } from "./logger";
export { resolveConfig } from "./config";
export { interpretWithMedGemma } from "./interpret";
export type { InterpretResult } from "./interpret";
export { withOptionalSynthesis } from "./optional-synthesis";
export { getSidecarErrorEnvelope, mapSidecarError } from "./sidecar-errors";

export type {
	ToolContext,
	ToolResult,
	ToolDefinition,
	HardwareProfile,
	ProfileConfig,
	OllamaClientInterface,
	PythonSidecarInterface,
	GenerateOpts,
	ClassifyResult,
	SidecarRequest,
	SidecarResponse,
	SidecarErrorEnvelope,
	SidecarErrorStage,
	Logger,
	LogLevel,
} from "./types";

export { PROFILES } from "./types";

// Test utilities — only used by test files across packages
export { createMockContext } from "./__tests__/test-helpers";
export { resilientFetch } from "./utils";
