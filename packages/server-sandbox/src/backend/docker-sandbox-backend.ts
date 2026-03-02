// ---------------------------------------------------------------------------
// DockerSandboxBackend — sole v1 implementation of SandboxBackend
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import {
	DEFAULT_MAX_ARTIFACT_BYTES,
	MAX_ARTIFACT_BYTES,
	MAX_LOG_BYTES,
	buildCreateArgs,
	buildExecArgs,
	buildLsArgs,
	buildNetworkArgs,
	buildRmArgs,
	buildStopArgs,
	defaultCommandRunner,
	defaultSandboxName,
	isPathSafe,
	normalizeStatus,
	parseLsJson,
	resolveConfig,
	truncateToBytes,
} from "./command";
import type {
	ArtifactInfo,
	CommandRunner,
	FetchArtifactInput,
	FetchArtifactResult,
	PrepareInput,
	PrepareResult,
	RunJobInput,
	RunJobResult,
	SandboxBackend,
	StatusInput,
	StatusResult,
	TeardownInput,
	TeardownResult,
} from "./types";
import { SandboxError } from "./types";

export class DockerSandboxBackend implements SandboxBackend {
	private readonly run: CommandRunner;

	constructor(commandRunner?: CommandRunner) {
		this.run = commandRunner ?? defaultCommandRunner;
	}

	// -----------------------------------------------------------------------
	// prepare (spec §5.1)
	// -----------------------------------------------------------------------

	async prepare(input: PrepareInput): Promise<PrepareResult> {
		const name = input.sandbox_name ?? defaultSandboxName(input.workspace_path);

		// Check if sandbox already exists
		const lsResult = await this.run(buildLsArgs());
		const existing = parseLsJson(lsResult.stdout);
		const found = existing.sandboxes.find((s) => s.name === name);

		if (found) {
			return {
				sandbox_name: name,
				created: false,
				workspace_path: input.workspace_path,
				status: normalizeStatus(found.status),
				template: input.template,
				network_policy: input.network_policy,
			};
		}

		// Create sandbox
		const createResult = await this.run(
			buildCreateArgs({ ...input, sandbox_name: name }),
		);
		if (createResult.exitCode !== 0) {
			throw new SandboxError(
				"SANDBOX_CREATE_FAILED",
				`docker sandbox create failed (exit ${createResult.exitCode}): ${createResult.stderr}`,
			);
		}

		// Apply network policy (default: deny)
		const policy = input.network_policy ?? "deny";
		const netResult = await this.run(
			buildNetworkArgs(name, policy, input.allow_hosts),
		);
		if (netResult.exitCode !== 0) {
			throw new SandboxError(
				"SANDBOX_NETWORK_POLICY_FAILED",
				`docker sandbox network proxy failed (exit ${netResult.exitCode}): ${netResult.stderr}`,
			);
		}

		return {
			sandbox_name: name,
			created: true,
			workspace_path: input.workspace_path,
			status: "running",
			template: input.template,
			network_policy: policy,
		};
	}

	// -----------------------------------------------------------------------
	// runJob (spec §5.2)
	// -----------------------------------------------------------------------

	async runJob(input: RunJobInput): Promise<RunJobResult> {
		const cfg = resolveConfig();
		const jobId =
			input.job_id ??
			`job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const timeoutSec = Math.min(
			input.timeout_sec ?? cfg.defaultTimeoutSec,
			cfg.maxTimeoutSec,
		);

		const start = performance.now();

		const result = await this.run(
			buildExecArgs({
				sandbox_name: input.sandbox_name,
				command: input.command,
				workdir: input.workdir,
				env: input.env,
			}),
			timeoutSec * 1000,
		);

		const durationMs = Math.round(performance.now() - start);

		if (result.timedOut) {
			throw new SandboxError(
				"SANDBOX_TIMEOUT",
				`Command timed out after ${timeoutSec}s`,
			);
		}

		// Truncate logs to MAX_LOG_BYTES (spec §7)
		const stdout = truncateToBytes(result.stdout, MAX_LOG_BYTES);
		const stderr = truncateToBytes(result.stderr, MAX_LOG_BYTES);

		// Save full logs to artifact root
		const artifactRoot =
			input.artifact_root ??
			path.join(input.workdir ?? input.sandbox_name, cfg.artifactRoot);
		const jobDir = path.join(artifactRoot, jobId);

		try {
			fs.mkdirSync(jobDir, { recursive: true });
			fs.writeFileSync(path.join(jobDir, "stdout.log"), result.stdout, "utf8");
			fs.writeFileSync(path.join(jobDir, "stderr.log"), result.stderr, "utf8");
			fs.writeFileSync(
				path.join(jobDir, "metadata.json"),
				JSON.stringify(
					{
						job_id: jobId,
						command: input.command,
						exit_code: result.exitCode,
						duration_ms: durationMs,
						timed_out: false,
					},
					null,
					2,
				),
				"utf8",
			);
		} catch {
			// Non-fatal: artifact writing may fail if path isn't host-visible
		}

		// Check expected artifacts
		const artifacts: ArtifactInfo[] = [];
		if (input.expected_artifacts) {
			for (const artPath of input.expected_artifacts) {
				try {
					const stat = fs.statSync(artPath);
					artifacts.push({
						path: artPath,
						exists: true,
						size_bytes: stat.size,
					});
				} catch {
					artifacts.push({ path: artPath, exists: false });
				}
			}
		}

		return {
			sandbox_name: input.sandbox_name,
			job_id: jobId,
			command: input.command,
			exit_code: result.exitCode,
			duration_ms: durationMs,
			stdout: stdout.content,
			stderr: stderr.content,
			timed_out: false,
			artifacts,
		};
	}

	// -----------------------------------------------------------------------
	// status (spec §5.3)
	// -----------------------------------------------------------------------

	async status(input: StatusInput): Promise<StatusResult> {
		const lsResult = await this.run(buildLsArgs());
		const parsed = parseLsJson(lsResult.stdout);
		const found = parsed.sandboxes.find((s) => s.name === input.sandbox_name);

		return {
			sandbox_name: input.sandbox_name,
			exists: !!found,
			status: found ? normalizeStatus(found.status) : "unknown",
		};
	}

	// -----------------------------------------------------------------------
	// fetchArtifact (spec §5.4)
	// -----------------------------------------------------------------------

	async fetchArtifact(input: FetchArtifactInput): Promise<FetchArtifactResult> {
		const encoding = input.encoding ?? "utf8";
		const maxBytes = Math.min(
			input.max_bytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
			MAX_ARTIFACT_BYTES,
		);

		const resolved = path.resolve(input.artifact_path);

		// Path traversal check
		if (input.artifact_path.includes("..")) {
			throw new SandboxError(
				"ARTIFACT_PATH_FORBIDDEN",
				`Path traversal detected in artifact path: ${input.artifact_path}`,
			);
		}

		// Check file exists
		let stat: fs.Stats;
		try {
			stat = fs.statSync(resolved);
		} catch {
			throw new SandboxError(
				"ARTIFACT_NOT_FOUND",
				`Artifact not found: ${input.artifact_path}`,
			);
		}

		if (stat.size > MAX_ARTIFACT_BYTES) {
			throw new SandboxError(
				"ARTIFACT_TOO_LARGE",
				`Artifact size ${stat.size} exceeds maximum ${MAX_ARTIFACT_BYTES} bytes`,
			);
		}

		// Read file
		const raw = fs.readFileSync(resolved);
		const truncated = raw.length > maxBytes;
		const slice = truncated ? raw.subarray(0, maxBytes) : raw;

		const content =
			encoding === "base64" ? slice.toString("base64") : slice.toString("utf8");

		return {
			sandbox_name: input.sandbox_name,
			artifact_path: input.artifact_path,
			size_bytes: stat.size,
			encoding,
			content,
			truncated,
		};
	}

	// -----------------------------------------------------------------------
	// teardown (spec §5.5)
	// -----------------------------------------------------------------------

	async teardown(input: TeardownInput): Promise<TeardownResult> {
		// Always stop first
		const stopResult = await this.run(buildStopArgs(input.sandbox_name));
		const stopped = stopResult.exitCode === 0;

		let removed = false;
		if (input.remove) {
			const rmResult = await this.run(buildRmArgs(input.sandbox_name));
			removed = rmResult.exitCode === 0;
		}

		return {
			sandbox_name: input.sandbox_name,
			removed,
			stopped,
		};
	}
}
