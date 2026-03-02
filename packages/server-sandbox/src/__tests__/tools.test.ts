import { describe, expect, mock, test } from "bun:test";
import { createMockContext } from "@medsci/core";
import { DockerSandboxBackend } from "../backend/docker-sandbox-backend";
import type { CliResult, CommandRunner } from "../backend/types";
import { sandboxFetchArtifact } from "../tools/sandbox-fetch-artifact";
import { sandboxPrepare } from "../tools/sandbox-prepare";
import { sandboxRunJob } from "../tools/sandbox-run-job";
import { sandboxStatus } from "../tools/sandbox-status";
import { sandboxTeardown } from "../tools/sandbox-teardown";

// ---------------------------------------------------------------------------
// Mock command runner factory
// ---------------------------------------------------------------------------

function createMockRunner(
	responses: Record<string, Partial<CliResult>>,
): CommandRunner {
	return mock((args: string[]) => {
		const key = args.join(" ");
		for (const [pattern, response] of Object.entries(responses)) {
			if (key.includes(pattern)) {
				return Promise.resolve({
					stdout: response.stdout ?? "",
					stderr: response.stderr ?? "",
					exitCode: response.exitCode ?? 0,
					timedOut: response.timedOut ?? false,
				});
			}
		}
		return Promise.resolve({
			stdout: "",
			stderr: "",
			exitCode: 0,
			timedOut: false,
		});
	}) as CommandRunner;
}

// ---------------------------------------------------------------------------
// DockerSandboxBackend with mocked runner
// ---------------------------------------------------------------------------

describe("DockerSandboxBackend", () => {
	test("prepare creates sandbox when not found", async () => {
		const runner = createMockRunner({
			"ls --json": { stdout: '{"sandboxes":[]}' },
			"sandbox create": { exitCode: 0 },
			"network proxy": { exitCode: 0 },
		});
		const backend = new DockerSandboxBackend(runner);

		const result = await backend.prepare({
			workspace_path: "/home/user/project",
			sandbox_name: "test-sb",
		});

		expect(result.created).toBe(true);
		expect(result.sandbox_name).toBe("test-sb");
		expect(result.status).toBe("running");
	});

	test("prepare returns existing sandbox idempotently", async () => {
		const runner = createMockRunner({
			"ls --json": {
				stdout: JSON.stringify({
					sandboxes: [{ name: "test-sb", status: "running" }],
				}),
			},
		});
		const backend = new DockerSandboxBackend(runner);

		const result = await backend.prepare({
			workspace_path: "/w",
			sandbox_name: "test-sb",
		});

		expect(result.created).toBe(false);
		expect(result.status).toBe("running");
	});

	test("prepare throws on create failure", async () => {
		const runner = createMockRunner({
			"ls --json": { stdout: '{"sandboxes":[]}' },
			"sandbox create": { exitCode: 1, stderr: "disk full" },
		});
		const backend = new DockerSandboxBackend(runner);

		const err = await backend
			.prepare({ workspace_path: "/w", sandbox_name: "sb" })
			.catch((e) => e);
		expect(err.code).toBe("SANDBOX_CREATE_FAILED");
	});

	test("runJob returns command output", async () => {
		const runner = createMockRunner({
			"sandbox exec": {
				stdout: "hello world\n",
				stderr: "",
				exitCode: 0,
			},
		});
		const backend = new DockerSandboxBackend(runner);

		const result = await backend.runJob({
			sandbox_name: "sb",
			command: "echo hello world",
		});

		expect(result.exit_code).toBe(0);
		expect(result.stdout).toContain("hello world");
		expect(result.timed_out).toBe(false);
		expect(result.job_id).toBeDefined();
		expect(result.duration_ms).toBeGreaterThanOrEqual(0);
	});

	test("runJob throws on timeout", async () => {
		const runner = createMockRunner({
			"sandbox exec": { timedOut: true, exitCode: 1 },
		});
		const backend = new DockerSandboxBackend(runner);

		const err = await backend
			.runJob({
				sandbox_name: "sb",
				command: "sleep 9999",
				timeout_sec: 1,
			})
			.catch((e) => e);
		expect(err.code).toBe("SANDBOX_TIMEOUT");
	});

	test("status returns exists=false for unknown sandbox", async () => {
		const runner = createMockRunner({
			"ls --json": { stdout: '{"sandboxes":[]}' },
		});
		const backend = new DockerSandboxBackend(runner);

		const result = await backend.status({ sandbox_name: "nonexistent" });

		expect(result.exists).toBe(false);
		expect(result.status).toBe("unknown");
	});

	test("status returns running sandbox state", async () => {
		const runner = createMockRunner({
			"ls --json": {
				stdout: JSON.stringify({
					sandboxes: [{ name: "sb", status: "running" }],
				}),
			},
		});
		const backend = new DockerSandboxBackend(runner);

		const result = await backend.status({ sandbox_name: "sb" });

		expect(result.exists).toBe(true);
		expect(result.status).toBe("running");
	});

	test("status retries and returns running once sandbox appears", async () => {
		const runner = mock((_args: string[]) => {
			if (runner.mock.calls.length <= 1) {
				return Promise.resolve({
					stdout: '{"sandboxes":[]}',
					stderr: "",
					exitCode: 0,
					timedOut: false,
				});
			}

			return Promise.resolve({
				stdout: JSON.stringify({
					sandboxes: [{ name: "sb", status: "running" }],
				}),
				stderr: "",
				exitCode: 0,
				timedOut: false,
			});
		}) as CommandRunner;

		const backend = new DockerSandboxBackend(runner);
		const result = await backend.status({ sandbox_name: "sb" });

		expect(result.exists).toBe(true);
		expect(result.status).toBe("running");
		expect(runner.mock.calls.length).toBe(2);
	});

	test("teardown stops sandbox", async () => {
		const runner = createMockRunner({
			"sandbox stop": { exitCode: 0 },
		});
		const backend = new DockerSandboxBackend(runner);

		const result = await backend.teardown({ sandbox_name: "sb" });

		expect(result.stopped).toBe(true);
		expect(result.removed).toBe(false);
	});

	test("teardown stops and removes sandbox", async () => {
		const runner = createMockRunner({
			"sandbox stop": { exitCode: 0 },
			"sandbox rm": { exitCode: 0 },
		});
		const backend = new DockerSandboxBackend(runner);

		const result = await backend.teardown({
			sandbox_name: "sb",
			remove: true,
		});

		expect(result.stopped).toBe(true);
		expect(result.removed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tool validation tests (via defineTool's schema validation)
// ---------------------------------------------------------------------------

describe("tool validation", () => {
	const ctx = createMockContext();

	test("sandbox_prepare rejects empty workspace_path", async () => {
		const result = await sandboxPrepare.execute(
			{ workspace_path: "" } as unknown as Parameters<
				typeof sandboxPrepare.execute
			>[0],
			ctx,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Invalid input");
	});

	test("sandbox_run_job rejects empty command", async () => {
		const result = await sandboxRunJob.execute(
			{ sandbox_name: "sb", command: "" } as unknown as Parameters<
				typeof sandboxRunJob.execute
			>[0],
			ctx,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Invalid input");
	});

	test("sandbox_run_job rejects missing sandbox_name", async () => {
		const result = await sandboxRunJob.execute(
			{ command: "echo hi" } as unknown as Parameters<
				typeof sandboxRunJob.execute
			>[0],
			ctx,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Invalid input");
	});

	test("sandbox_status rejects empty sandbox_name", async () => {
		const result = await sandboxStatus.execute(
			{ sandbox_name: "" } as unknown as Parameters<
				typeof sandboxStatus.execute
			>[0],
			ctx,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Invalid input");
	});

	test("sandbox_fetch_artifact rejects empty artifact_path", async () => {
		const result = await sandboxFetchArtifact.execute(
			{ sandbox_name: "sb", artifact_path: "" } as unknown as Parameters<
				typeof sandboxFetchArtifact.execute
			>[0],
			ctx,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Invalid input");
	});

	test("sandbox_teardown rejects empty sandbox_name", async () => {
		const result = await sandboxTeardown.execute(
			{ sandbox_name: "" } as unknown as Parameters<
				typeof sandboxTeardown.execute
			>[0],
			ctx,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Invalid input");
	});
});

// ---------------------------------------------------------------------------
// fetchArtifact — path traversal rejection
// ---------------------------------------------------------------------------

describe("fetchArtifact path safety", () => {
	test("rejects path traversal", async () => {
		const runner = createMockRunner({});
		const backend = new DockerSandboxBackend(runner);

		const err = await backend
			.fetchArtifact({
				sandbox_name: "sb",
				artifact_path: "/home/user/../etc/passwd",
			})
			.catch((e) => e);
		expect(err.code).toBe("ARTIFACT_PATH_FORBIDDEN");
	});
});
