import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PythonSidecarInterface,
  SidecarRequest,
  SidecarResponse,
} from "../types";
import { createLogger } from "../logger";

const SIDECAR_SCRIPT = fileURLToPath(
  new URL("../../python/sidecar.py", import.meta.url),
);

// Project root derived from sidecar script location (packages/core/python/sidecar.py → ../../..)
const PROJECT_ROOT = path.resolve(path.dirname(SIDECAR_SCRIPT), "../../..");

const DEFAULT_TIMEOUT_MS = 60_000;
const HEALTH_CHECK_TIMEOUT_MS = 10_000;

/**
 * Long-running Python sidecar process communicating via JSON-RPC over
 * stdin/stdout. Pre-imports heavy scientific libraries once, then handles
 * requests without re-spawning (Issue #14).
 */
export class PythonSidecar implements PythonSidecarInterface {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private log = createLogger("python-sidecar");
  private preloadLibs: string[];
  private timeoutMs: number;

  constructor(opts?: { preloadLibs?: string[]; timeoutMs?: number }) {
    this.preloadLibs = opts?.preloadLibs ?? [];
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;

    const rawPython = process.env.MEDSCI_PYTHON ?? "python3";
    const pythonBin = rawPython.startsWith("/") ? rawPython : path.resolve(PROJECT_ROOT, rawPython);
    this.proc = spawn(pythonBin, [SIDECAR_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        MEDSCI_PRELOAD: JSON.stringify(this.preloadLibs),
      },
    });

    this.proc.on("exit", (code) => {
      this.log.warn(`sidecar exited with code ${code}`);
      // Reject all pending requests
      for (const [id, { reject }] of this.pending) {
        reject(new Error(`Sidecar exited (code ${code}) while awaiting ${id}`));
      }
      this.pending.clear();
      this.proc = null;
      this.rl = null;
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) this.log.warn(`stderr: ${msg}`);
    });

    // Read line-delimited JSON responses from stdout
    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line: string) => {
      try {
        const resp: SidecarResponse = JSON.parse(line);
        const entry = this.pending.get(resp.id);
        if (!entry) {
          this.log.warn(`response for unknown request ${resp.id}`);
          return;
        }
        this.pending.delete(resp.id);
        if (resp.error) {
          entry.reject(new Error(resp.error));
        } else {
          entry.resolve(resp.result);
        }
      } catch {
        this.log.error(`unparseable sidecar output: ${line}`);
      }
    });

    // Wait for health check
    await this.call("__health__", {});
    this.log.info("sidecar started and healthy");
  }

  async call<T = unknown>(
    method: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    if (!this.isRunning() && method !== "__health__") {
      await this.start();
    }
    if (!this.proc?.stdin) {
      throw new Error("Sidecar stdin not available");
    }

    const id = randomUUID();
    const request: SidecarRequest = { id, method, args };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Sidecar call ${method} timed out after ${this.timeoutMs}ms`,
          ),
        );
      }, method === "__health__" ? HEALTH_CHECK_TIMEOUT_MS : this.timeoutMs);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timeout);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      });

      this.proc!.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning()) return;
    try {
      await this.call("__shutdown__", {});
    } catch {
      // Best-effort — process may already be exiting
    }
    this.proc?.kill("SIGTERM");
    this.proc = null;
    this.rl = null;
    this.pending.clear();
    this.log.info("sidecar stopped");
  }
}
