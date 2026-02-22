import type { z } from "zod";

// ---------------------------------------------------------------------------
// Hardware profiles
// ---------------------------------------------------------------------------

export type HardwareProfile = "lite" | "standard" | "full";

export interface ProfileConfig {
  /** Ollama model tag for the reasoning LLM */
  reasoningModel: string;
  /** Python libraries to pre-import in the sidecar */
  pythonPreload: string[] | "all";
}

export const PROFILES: Record<HardwareProfile, ProfileConfig> = {
  lite: {
    reasoningModel: "medgemma:latest",
    pythonPreload: ["rdkit"],
  },
  standard: {
    reasoningModel: "medgemma:latest",
    pythonPreload: ["rdkit", "scanpy", "biopython", "leidenalg", "igraph", "pynndescent"],
  },
  full: {
    reasoningModel: "medgemma:latest",
    pythonPreload: "all",
  },
};

// ---------------------------------------------------------------------------
// Tool system
// ---------------------------------------------------------------------------

export interface ToolContext {
  /** Ollama client for LLM inference */
  ollama: OllamaClientInterface;
  /** Python sidecar for scientific libraries */
  python: PythonSidecarInterface;
  /** Structured logger */
  log: Logger;
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /** Milliseconds elapsed */
  duration_ms?: number;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  execute: (input: TInput, ctx: ToolContext) => Promise<ToolResult<TOutput>>;
}

// ---------------------------------------------------------------------------
// Model clients
// ---------------------------------------------------------------------------

export interface OllamaClientInterface {
  generate(prompt: string, opts?: GenerateOpts): Promise<string>;
  generateJson<T = unknown>(prompt: string, opts?: GenerateOpts): Promise<T>;
  /** @reserved — not yet used by any tool; kept for future semantic search */
  embed(text: string, model?: string): Promise<number[]>;
  /** @reserved — not yet used by any tool; kept for future classification pipelines */
  classify(prompt: string, labels: string[]): Promise<ClassifyResult>;
  isAvailable(): Promise<boolean>;
}

export interface GenerateOpts {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  system?: string;
  /** Base64-encoded images for multimodal models (e.g. MedGemma vision) */
  images?: string[];
}

export interface ClassifyResult {
  label: string;
  score: number;
  allScores: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Python sidecar
// ---------------------------------------------------------------------------

export interface PythonSidecarInterface {
  call<T = unknown>(method: string, args: Record<string, unknown>): Promise<T>;
  isRunning(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SidecarRequest {
  id: string;
  method: string;
  args: Record<string, unknown>;
}

export interface SidecarResponse {
  id: string;
  result?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}
