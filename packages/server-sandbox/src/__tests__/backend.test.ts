import { describe, expect, test } from "bun:test";
import {
	buildCreateArgs,
	buildExecArgs,
	buildLsArgs,
	buildNetworkArgs,
	buildRmArgs,
	buildStopArgs,
	defaultSandboxName,
	isPathSafe,
	normalizeStatus,
	parseLsJson,
	truncateToBytes,
} from "../backend/command";

// ---------------------------------------------------------------------------
// buildCreateArgs
// ---------------------------------------------------------------------------

describe("buildCreateArgs", () => {
	test("builds minimal create command", () => {
		const args = buildCreateArgs({ workspace_path: "/home/user/project" });
		expect(args[0]).toBe("sandbox");
		expect(args[1]).toBe("create");
		expect(args).toContain("opencode");
		expect(args).toContain("/home/user/project");
		expect(args).toContain("--pull-template");
	});

	test("includes explicit sandbox name", () => {
		const args = buildCreateArgs({
			workspace_path: "/w",
			sandbox_name: "my-sandbox",
		});
		expect(args).toContain("--name");
		expect(args[args.indexOf("--name") + 1]).toBe("my-sandbox");
	});

	test("includes template flag", () => {
		const args = buildCreateArgs({
			workspace_path: "/w",
			template: "python:3.12",
		});
		expect(args).toContain("-t");
		expect(args[args.indexOf("-t") + 1]).toBe("python:3.12");
	});

	test("includes pull policy", () => {
		const args = buildCreateArgs({
			workspace_path: "/w",
			pull_template: "always",
		});
		expect(args).toContain("--pull-template");
		expect(args[args.indexOf("--pull-template") + 1]).toBe("always");
	});

	test("includes extra workspaces", () => {
		const args = buildCreateArgs({
			workspace_path: "/w",
			extra_workspaces: [
				{ path: "/data", read_only: true },
				{ path: "/output" },
			],
		});
		expect(args).toContain("/data:ro");
		expect(args).toContain("/output");
	});
});

// ---------------------------------------------------------------------------
// buildExecArgs
// ---------------------------------------------------------------------------

describe("buildExecArgs", () => {
	test("builds basic exec command", () => {
		const args = buildExecArgs({
			sandbox_name: "test-sb",
			command: "echo hello",
		});
		expect(args).toEqual([
			"sandbox",
			"exec",
			"test-sb",
			"/bin/sh",
			"-lc",
			"echo hello",
		]);
	});

	test("includes workdir", () => {
		const args = buildExecArgs({
			sandbox_name: "test-sb",
			command: "ls",
			workdir: "/app",
		});
		expect(args).toContain("--workdir");
		expect(args[args.indexOf("--workdir") + 1]).toBe("/app");
	});

	test("includes env vars", () => {
		const args = buildExecArgs({
			sandbox_name: "test-sb",
			command: "echo $FOO",
			env: { FOO: "bar", BAZ: "qux" },
		});
		expect(args).toContain("-e");
		expect(args).toContain("FOO=bar");
		expect(args).toContain("BAZ=qux");
	});
});

// ---------------------------------------------------------------------------
// buildNetworkArgs
// ---------------------------------------------------------------------------

describe("buildNetworkArgs", () => {
	test("builds deny policy", () => {
		const args = buildNetworkArgs("my-sb", "deny");
		expect(args).toEqual([
			"sandbox",
			"network",
			"proxy",
			"my-sb",
			"--policy",
			"deny",
		]);
	});

	test("builds allow policy with hosts", () => {
		const args = buildNetworkArgs("my-sb", "allow", ["pypi.org", "github.com"]);
		expect(args).toContain("--allow-host");
		expect(args).toContain("pypi.org");
		expect(args).toContain("github.com");
	});
});

// ---------------------------------------------------------------------------
// buildLsArgs, buildStopArgs, buildRmArgs
// ---------------------------------------------------------------------------

describe("simple command builders", () => {
	test("buildLsArgs", () => {
		expect(buildLsArgs()).toEqual(["sandbox", "ls", "--json"]);
	});

	test("buildStopArgs", () => {
		expect(buildStopArgs("sb1")).toEqual(["sandbox", "stop", "sb1"]);
	});

	test("buildRmArgs", () => {
		expect(buildRmArgs("sb1")).toEqual(["sandbox", "rm", "sb1"]);
	});
});

// ---------------------------------------------------------------------------
// parseLsJson
// ---------------------------------------------------------------------------

describe("parseLsJson", () => {
	test("parses empty sandboxes array", () => {
		const result = parseLsJson('{ "sandboxes": [] }');
		expect(result.sandboxes).toEqual([]);
	});

	test("parses populated sandboxes array", () => {
		const json = JSON.stringify({
			sandboxes: [
				{ name: "sb-1", status: "running" },
				{ name: "sb-2", status: "stopped" },
			],
		});
		const result = parseLsJson(json);
		expect(result.sandboxes).toHaveLength(2);
		expect(result.sandboxes[0].name).toBe("sb-1");
		expect(result.sandboxes[1].status).toBe("stopped");
	});

	test("returns empty on invalid JSON", () => {
		const result = parseLsJson("not json at all");
		expect(result.sandboxes).toEqual([]);
	});

	test("returns empty when sandboxes field missing", () => {
		const result = parseLsJson('{ "other": true }');
		expect(result.sandboxes).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// normalizeStatus
// ---------------------------------------------------------------------------

describe("normalizeStatus", () => {
	test("maps running", () => {
		expect(normalizeStatus("running")).toBe("running");
		expect(normalizeStatus("Running")).toBe("running");
	});

	test("maps stopped/exited", () => {
		expect(normalizeStatus("stopped")).toBe("stopped");
		expect(normalizeStatus("exited")).toBe("stopped");
	});

	test("maps unknown for undefined or unrecognized", () => {
		expect(normalizeStatus(undefined)).toBe("unknown");
		expect(normalizeStatus("paused")).toBe("unknown");
	});
});

// ---------------------------------------------------------------------------
// isPathSafe
// ---------------------------------------------------------------------------

describe("isPathSafe", () => {
	test("allows path under allowed root", () => {
		expect(
			isPathSafe("/home/user/project/file.txt", ["/home/user/project"]),
		).toBe(true);
	});

	test("allows exact root", () => {
		expect(isPathSafe("/home/user/project", ["/home/user/project"])).toBe(true);
	});

	test("rejects path traversal", () => {
		expect(
			isPathSafe("/home/user/project/../secret", ["/home/user/project"]),
		).toBe(false);
	});

	test("rejects path outside roots", () => {
		expect(isPathSafe("/etc/passwd", ["/home/user/project"])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// truncateToBytes
// ---------------------------------------------------------------------------

describe("truncateToBytes", () => {
	test("does not truncate short string", () => {
		const result = truncateToBytes("hello", 100);
		expect(result.content).toBe("hello");
		expect(result.truncated).toBe(false);
	});

	test("truncates long string", () => {
		const long = "a".repeat(200);
		const result = truncateToBytes(long, 100);
		expect(result.content.length).toBeLessThanOrEqual(100);
		expect(result.truncated).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// defaultSandboxName
// ---------------------------------------------------------------------------

describe("defaultSandboxName", () => {
	test("returns deterministic name", () => {
		const a = defaultSandboxName("/home/user/project");
		const b = defaultSandboxName("/home/user/project");
		expect(a).toBe(b);
	});

	test("starts with medsci prefix", () => {
		const name = defaultSandboxName("/anything");
		expect(name).toMatch(/^medsci-/);
	});

	test("different paths produce different names", () => {
		const a = defaultSandboxName("/path/a");
		const b = defaultSandboxName("/path/b");
		expect(a).not.toBe(b);
	});
});
