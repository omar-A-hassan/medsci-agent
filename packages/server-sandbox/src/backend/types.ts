// ---------------------------------------------------------------------------
// Backend interface & types for sandbox lifecycle
// ---------------------------------------------------------------------------

/** Error codes from spec §8 */
export type SandboxErrorCode =
	| "SANDBOX_NOT_FOUND"
	| "SANDBOX_CREATE_FAILED"
	| "SANDBOX_EXEC_FAILED"
	| "SANDBOX_TIMEOUT"
	| "SANDBOX_NETWORK_POLICY_FAILED"
	| "ARTIFACT_NOT_FOUND"
	| "ARTIFACT_PATH_FORBIDDEN"
	| "ARTIFACT_TOO_LARGE"
	| "CLI_UNAVAILABLE";

export class SandboxError extends Error {
	constructor(
		public readonly code: SandboxErrorCode,
		message: string,
	) {
		super(message);
		this.name = "SandboxError";
	}
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

export interface PrepareInput {
	workspace_path: string;
	sandbox_name?: string;
	template?: string;
	pull_template?: "missing" | "always" | "never";
	extra_workspaces?: Array<{ path: string; read_only?: boolean }>;
	network_policy?: "deny" | "allow";
	allow_hosts?: string[];
}

export interface PrepareResult {
	sandbox_name: string;
	created: boolean;
	workspace_path: string;
	status: "running" | "stopped" | "unknown";
	template?: string;
	network_policy?: "deny" | "allow";
}

// ---------------------------------------------------------------------------
// runJob
// ---------------------------------------------------------------------------

export interface RunJobInput {
	sandbox_name: string;
	job_id?: string;
	command: string;
	workdir?: string;
	env?: Record<string, string>;
	timeout_sec?: number;
	expected_artifacts?: string[];
	artifact_root?: string;
}

export interface ArtifactInfo {
	path: string;
	exists: boolean;
	size_bytes?: number;
}

export interface RunJobResult {
	sandbox_name: string;
	job_id: string;
	command: string;
	exit_code: number;
	duration_ms: number;
	stdout: string;
	stderr: string;
	timed_out: boolean;
	artifacts: ArtifactInfo[];
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface StatusInput {
	sandbox_name: string;
}

export interface StatusResult {
	sandbox_name: string;
	exists: boolean;
	status: "running" | "stopped" | "unknown";
}

// ---------------------------------------------------------------------------
// fetchArtifact
// ---------------------------------------------------------------------------

export interface FetchArtifactInput {
	sandbox_name: string;
	artifact_path: string;
	encoding?: "utf8" | "base64";
	max_bytes?: number;
}

export interface FetchArtifactResult {
	sandbox_name: string;
	artifact_path: string;
	size_bytes: number;
	encoding: "utf8" | "base64";
	content: string;
	truncated: boolean;
}

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

export interface TeardownInput {
	sandbox_name: string;
	remove?: boolean;
}

export interface TeardownResult {
	sandbox_name: string;
	removed: boolean;
	stopped: boolean;
}

// ---------------------------------------------------------------------------
// Backend interface (spec §6)
// ---------------------------------------------------------------------------

export interface SandboxBackend {
	prepare(input: PrepareInput): Promise<PrepareResult>;
	runJob(input: RunJobInput): Promise<RunJobResult>;
	status(input: StatusInput): Promise<StatusResult>;
	fetchArtifact(input: FetchArtifactInput): Promise<FetchArtifactResult>;
	teardown(input: TeardownInput): Promise<TeardownResult>;
}

// ---------------------------------------------------------------------------
// CLI runner abstraction (for DI / mocking)
// ---------------------------------------------------------------------------

export interface CliResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
}

export type CommandRunner = (
	args: string[],
	timeoutMs?: number,
) => Promise<CliResult>;

// ---------------------------------------------------------------------------
// docker sandbox ls --json shape
// ---------------------------------------------------------------------------

export interface SandboxLsEntry {
	name: string;
	status: string;
	[key: string]: unknown;
}

export interface SandboxLsOutput {
	sandboxes: SandboxLsEntry[];
}
