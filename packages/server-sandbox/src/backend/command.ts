// ---------------------------------------------------------------------------
// CLI command building & parsing utilities
// Pure functions — primary unit‑testing surface.
// ---------------------------------------------------------------------------

import { normalize, resolve } from "node:path";
import type {
	CliResult,
	CommandRunner,
	PrepareInput,
	SandboxLsOutput,
} from "./types";
import { SandboxError } from "./types";

// ---------------------------------------------------------------------------
// Policy / safety constants (spec §7)
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_SEC = 600;
export const MAX_TIMEOUT_SEC = 3600;
export const MAX_LOG_BYTES = 1_048_576; // 1 MB
export const DEFAULT_MAX_ARTIFACT_BYTES = 1_048_576; // 1 MB
export const MAX_ARTIFACT_BYTES = 10_485_760; // 10 MB

// ---------------------------------------------------------------------------
// Config from env (spec §10)
// ---------------------------------------------------------------------------

export function resolveConfig() {
	return {
		defaultTemplate: process.env.MEDSCI_SANDBOX_DEFAULT_TEMPLATE,
		pullTemplate:
			(process.env.MEDSCI_SANDBOX_PULL_TEMPLATE as
				| "missing"
				| "always"
				| "never") ?? "missing",
		artifactRoot:
			process.env.MEDSCI_SANDBOX_ARTIFACT_ROOT ?? "sandbox-artifacts",
		defaultTimeoutSec:
			Number(process.env.MEDSCI_SANDBOX_DEFAULT_TIMEOUT_SEC) ||
			DEFAULT_TIMEOUT_SEC,
		maxTimeoutSec:
			Number(process.env.MEDSCI_SANDBOX_MAX_TIMEOUT_SEC) || MAX_TIMEOUT_SEC,
	};
}

// ---------------------------------------------------------------------------
// Sandbox name helpers (spec §4 — deterministic default)
// ---------------------------------------------------------------------------

export function defaultSandboxName(workspacePath: string): string {
	const profile = process.env.MEDSCI_PROFILE ?? "standard";
	// Simple deterministic hash from workspace path
	let hash = 0;
	for (let i = 0; i < workspacePath.length; i++) {
		hash = (hash * 31 + workspacePath.charCodeAt(i)) | 0;
	}
	const hex = Math.abs(hash).toString(16).slice(0, 8);
	return `medsci-${profile}-${hex}`;
}

// ---------------------------------------------------------------------------
// Path safety (spec §7)
// ---------------------------------------------------------------------------

export function isPathSafe(
	targetPath: string,
	allowedRoots: string[],
): boolean {
	const normalized = normalize(resolve(targetPath));
	// Reject path traversal
	if (targetPath.includes("..")) {
		return false;
	}
	return allowedRoots.some((root) => {
		const normalizedRoot = normalize(resolve(root));
		return (
			normalized === normalizedRoot ||
			normalized.startsWith(`${normalizedRoot}/`)
		);
	});
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

/**
 * Build args for `docker sandbox create`.
 * Spec §5.1 command mapping.
 */
export function buildCreateArgs(input: PrepareInput): string[] {
	const args = ["sandbox", "create"];

	if (input.sandbox_name) {
		args.push("--name", input.sandbox_name);
	}

	const pullPolicy = input.pull_template ?? resolveConfig().pullTemplate;
	args.push("--pull-template", pullPolicy);

	const template = input.template ?? resolveConfig().defaultTemplate;
	if (template) {
		args.push("-t", template);
	}

	// opencode profile keyword
	args.push("opencode");

	// Primary workspace
	args.push(input.workspace_path);

	// Extra workspaces
	if (input.extra_workspaces) {
		for (const ws of input.extra_workspaces) {
			const wsArg = ws.read_only ? `${ws.path}:ro` : ws.path;
			args.push(wsArg);
		}
	}

	return args;
}

/**
 * Build args for `docker sandbox network proxy`.
 * Spec §5.1 network section.
 */
export function buildNetworkArgs(
	sandboxName: string,
	policy: "deny" | "allow",
	allowHosts?: string[],
): string[] {
	const args = ["sandbox", "network", "proxy", sandboxName, "--policy", policy];
	if (allowHosts) {
		for (const host of allowHosts) {
			args.push("--allow-host", host);
		}
	}
	return args;
}

/**
 * Build args for `docker sandbox exec`.
 * Spec §5.2 command mapping.
 */
export function buildExecArgs(input: {
	sandbox_name: string;
	command: string;
	workdir?: string;
	env?: Record<string, string>;
}): string[] {
	const args = ["sandbox", "exec"];

	if (input.workdir) {
		args.push("--workdir", input.workdir);
	}

	if (input.env) {
		for (const [k, v] of Object.entries(input.env)) {
			args.push("-e", `${k}=${v}`);
		}
	}

	args.push(input.sandbox_name);
	args.push("/bin/sh", "-lc", input.command);

	return args;
}

/**
 * Build args for `docker sandbox ls --json`.
 */
export function buildLsArgs(): string[] {
	return ["sandbox", "ls", "--json"];
}

/**
 * Build args for `docker sandbox stop`.
 */
export function buildStopArgs(sandboxName: string): string[] {
	return ["sandbox", "stop", sandboxName];
}

/**
 * Build args for `docker sandbox rm`.
 */
export function buildRmArgs(sandboxName: string): string[] {
	return ["sandbox", "rm", sandboxName];
}

// ---------------------------------------------------------------------------
// Output parsers
// ---------------------------------------------------------------------------

/**
 * Parse `docker sandbox ls --json` output.
 * Tolerates extra fields; returns empty array on parse failure.
 */
export function parseLsJson(stdout: string): SandboxLsOutput {
	try {
		const parsed = JSON.parse(stdout);
		if (parsed && Array.isArray(parsed.sandboxes)) {
			return parsed as SandboxLsOutput;
		}
		return { sandboxes: [] };
	} catch {
		return { sandboxes: [] };
	}
}

/**
 * Map raw status string from `docker sandbox ls` to our union.
 */
export function normalizeStatus(
	raw: string | undefined,
): "running" | "stopped" | "unknown" {
	if (!raw) return "unknown";
	const lower = raw.toLowerCase();
	if (lower.includes("running")) return "running";
	if (lower.includes("stop") || lower.includes("exited")) return "stopped";
	return "unknown";
}

/**
 * Truncate a string to the given byte length.
 * Returns { content, truncated }.
 */
export function truncateToBytes(
	str: string,
	maxBytes: number,
): { content: string; truncated: boolean } {
	const buf = Buffer.from(str, "utf8");
	if (buf.length <= maxBytes) {
		return { content: str, truncated: false };
	}
	return {
		content: buf.subarray(0, maxBytes).toString("utf8"),
		truncated: true,
	};
}

// ---------------------------------------------------------------------------
// Default command runner (Bun.spawn)
// ---------------------------------------------------------------------------

export const defaultCommandRunner: CommandRunner = async (
	args: string[],
	timeoutMs?: number,
): Promise<CliResult> => {
	const timeout = timeoutMs ?? DEFAULT_TIMEOUT_SEC * 1000;
	let timedOut = false;

	try {
		const proc = Bun.spawn(["docker", ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});

		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<void>((_, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				proc.kill();
				reject(new Error("timeout"));
			}, timeout);
		});

		try {
			await Promise.race([proc.exited, timeoutPromise]);
		} catch {
			// timeout — kill already called
		} finally {
			if (timer) clearTimeout(timer);
		}

		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const exitCode = proc.exitCode ?? 1;

		return { stdout, stderr, exitCode, timedOut };
	} catch (err) {
		if (timedOut) {
			throw new SandboxError("SANDBOX_TIMEOUT", "Command timed out");
		}
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("ENOENT") || msg.includes("not found")) {
			throw new SandboxError(
				"CLI_UNAVAILABLE",
				"Docker CLI not found. Ensure docker is installed and in PATH.",
			);
		}
		throw new SandboxError("SANDBOX_EXEC_FAILED", `CLI error: ${msg}`);
	}
};
