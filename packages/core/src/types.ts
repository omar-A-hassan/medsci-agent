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
		pythonPreload: [
			"rdkit",
			"scanpy",
			"biopython",
			"leidenalg",
			"igraph",
			"pynndescent",
		],
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

export type SidecarErrorStage =
	| "acquire"
	| "index"
	| "query"
	| "startup"
	| "ipc"
	| "unknown";

export interface SidecarErrorEnvelope {
	error_code?: string;
	error_message?: string;
	error_stage?: SidecarErrorStage;
	error_detail?: string;
	traceback?: string;
	retryable?: boolean;
}

export interface SidecarResponse {
	id: string;
	result?: unknown;
	error?: string;
	error_code?: string;
	error_message?: string;
	error_stage?: SidecarErrorStage;
	error_detail?: string;
	traceback?: string;
	retryable?: boolean;
}

// ---------------------------------------------------------------------------
// Acquisition contract
// ---------------------------------------------------------------------------

export type AcquisitionSourceType = "doi" | "pmid" | "pmcid" | "url";

export type AcquisitionRetrievalMethod =
	| "ncbi_bioc"
	| "scrapling_html"
	| "scrapling_pdf"
	| "cached";

export type AcquisitionExtractionBackend =
	| "scrapling"
	| "beautifulsoup"
	| "regex"
	| "pdf_text"
	| "plain_text";

export type AcquisitionLicenseHint = "open_access" | "unknown" | "restricted";

export interface AcquiredDocumentMetadata {
	title?: string;
	authors?: string[];
	published_at?: string;
	journal?: string;
	doi?: string;
}

export interface AcquisitionPolicyDecision {
	allowed: boolean;
	blocked: boolean;
	reason?: string;
}

export interface AcquiredDocument {
	source_id: string;
	source_type: AcquisitionSourceType;
	provenance_url: string;
	retrieval_method: AcquisitionRetrievalMethod;
	license_hint: AcquisitionLicenseHint;
	text: string;
	text_hash: string;
	metadata: AcquiredDocumentMetadata;
	extraction_confidence: number;
	extraction_backend?: AcquisitionExtractionBackend;
	fallback_used?: boolean;
	policy: AcquisitionPolicyDecision;
	content_level?: "metadata" | "abstract" | "full_text";
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
