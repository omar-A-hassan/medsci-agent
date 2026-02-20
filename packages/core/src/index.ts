// @medsci/core — shared infrastructure for all MCP servers

export { defineTool } from "./tool-factory";
export { createMcpServer } from "./server-factory";
export { OllamaClient } from "./models/ollama";
export { PythonSidecar } from "./models/python-sidecar";
export { createLogger } from "./logger";
export { resolveConfig } from "./config";
export { interpretWithMedGemma } from "./interpret";
export type { InterpretResult } from "./interpret";

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
  Logger,
  LogLevel,
} from "./types";

export { PROFILES } from "./types";
