import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { PythonSidecar } from "../models/python-sidecar";

// Mock child_process and readline
mock.module("node:child_process", () => ({
	spawn: mock(() => {
		const proc = new EventEmitter() as unknown as ChildProcess;
		proc.stdin = new PassThrough();
		proc.stdout = new PassThrough();
		proc.stderr = new PassThrough();
		proc.kill = mock();
		(proc as any).exitCode = null;
		return proc;
	}),
}));

mock.module("node:readline", () => ({
	createInterface: mock(() => {
		const rl = new EventEmitter();
		return rl;
	}),
}));

describe("PythonSidecar", () => {
	let sidecar: PythonSidecar;

	beforeEach(() => {
		sidecar = new PythonSidecar({ timeoutMs: 1000 });
	});

	afterEach(async () => {
		await sidecar.stop();
	});

	test("instantiates successfully", () => {
		expect(sidecar).toBeDefined();
		expect(sidecar.isRunning()).toBe(false);
	});

	test("retries RPC call once if sidecar crashes", async () => {
		// We will simulate a failure: The start() logic works, we send a request.
		// The sidecar process crashes, dropping the promise.
		// The wrapper logic should catch the failure, restart the sidecar, and try again.

		// Override the actual internal call logic to simulate a crash on attempt 1, and success on attempt 2.
		let attempts = 0;

		// We mock the internal components since testing actual child_process IO in bun is brittle.
		// We will just directly test the wrapped logic by subclassing or mocking `this.isRunning()` and `start()`.

		const originalStart = sidecar.start.bind(sidecar);
		sidecar.start = mock(async () => {
			// Fake a running state
			(sidecar as any).proc = { stdin: new PassThrough(), exitCode: null };
			(sidecar as any).rl = new EventEmitter();
		});

		sidecar.isRunning = mock(() => {
			// Is running if it has been started and we haven't crashed it yet.
			return !!(sidecar as any).proc && (sidecar as any).proc.exitCode === null;
		});

		// We can simulate the sidecar crashing by overriding the `try/catch` block's internal `attemptCall`.
		// Since `attemptCall` is a closure, we can't easily mock it.
		// Instead we will mock `proc.stdin.write` which `attemptCall` uses.

		sidecar.start = mock(async () => {
			(sidecar as any).proc = {
				stdin: {
					write: mock((data, cb) => {
						attempts++;
						if (attempts === 1) {
							// Attempt 1: Simulate process crash, which rejects all pending requests.
							(sidecar as any).proc.exitCode = 1; // Mark as dead
							const pendingMap = (sidecar as any).pending;
							for (const [id, { reject }] of pendingMap) {
								reject(new Error("Sidecar exited"));
							}
							pendingMap.clear();
						} else {
							// Attempt 2: Resolve it successfully.
							// In the real world, the python script prints JSON to stdout.
							// We just manually trigger the resolve here for the test.
							const pendingMap = (sidecar as any).pending;
							for (const [id, { resolve }] of pendingMap) {
								resolve({ fake: "success" });
							}
						}
					}),
				},
				exitCode: null,
				kill: mock(),
			};
			(sidecar as any).rl = new EventEmitter();
		});

		const result = await sidecar.call("test.method", {});

		expect(attempts).toBe(2);
		expect(result).toEqual({ fake: "success" });
	});

	test("builds typed sidecar errors with envelope metadata", () => {
		const resp = {
			id: "abc",
			error: "failure",
			error_code: "MODEL_NOT_FOUND",
			error_message: "Model missing",
			error_stage: "startup",
			retryable: false,
			traceback: "tb",
		};

		const err = (sidecar as any).buildSidecarError(resp);
		expect(err).toBeInstanceOf(Error);
		expect((err as any).sidecar.error_code).toBe("MODEL_NOT_FOUND");
		expect((err as any).sidecar.error_stage).toBe("startup");
		expect((err as any).sidecar.retryable).toBe(false);
	});
});
