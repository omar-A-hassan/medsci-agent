import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CORE_SIDECAR_SCRIPT = fileURLToPath(
	new URL("../../python/sidecar.py", import.meta.url),
);

// packages/core/src/models -> project root
const PROJECT_ROOT = path.resolve(path.dirname(CORE_SIDECAR_SCRIPT), "../../..");

export interface PythonSidecarOptions {
	scriptPath?: string;
	pythonBin?: string;
	preloadLibs?: string[];
	timeoutMs?: number;
}

export interface ResolvedPythonSidecarOptions {
	scriptPath: string;
	pythonBin: string;
	preloadLibs: string[];
	timeoutMs: number;
}

function resolvePythonBin(rawPython: string): string {
	if (path.isAbsolute(rawPython)) {
		return rawPython;
	}

	// Keep plain executable names (e.g. `python3`) on PATH.
	if (!rawPython.includes("/") && !rawPython.includes("\\")) {
		return rawPython;
	}

	// Relative paths are resolved from the project root for consistency.
	return path.resolve(PROJECT_ROOT, rawPython);
}

export function resolvePythonSidecarOptions(
	opts: PythonSidecarOptions | undefined,
	defaultTimeoutMs: number,
): ResolvedPythonSidecarOptions {
	const scriptPath = opts?.scriptPath ?? CORE_SIDECAR_SCRIPT;
	const rawPython = opts?.pythonBin ?? process.env.MEDSCI_PYTHON ?? "python3";
	const pythonBin = resolvePythonBin(rawPython);

	if (!existsSync(scriptPath)) {
		throw new Error(`Python sidecar script not found: ${scriptPath}`);
	}

	return {
		scriptPath,
		pythonBin,
		preloadLibs: opts?.preloadLibs ?? [],
		timeoutMs: opts?.timeoutMs ?? defaultTimeoutMs,
	};
}
