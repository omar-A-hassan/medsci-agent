import type { LogLevel, Logger } from "./types";

const LEVEL_ORDER: LogLevel[] = ["debug", "info", "warn", "error"];

const COLORS: Record<LogLevel, string> = {
	debug: "\x1b[90m", // gray
	info: "\x1b[36m", // cyan
	warn: "\x1b[33m", // yellow
	error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";

export function createLogger(
	prefix: string,
	minLevel: LogLevel = "info",
): Logger {
	const minIdx = LEVEL_ORDER.indexOf(minLevel);

	function emit(level: LogLevel, msg: string, data?: unknown) {
		if (LEVEL_ORDER.indexOf(level) < minIdx) return;
		const ts = new Date().toISOString();
		const color = COLORS[level];
		const line = `${color}[${ts}] [${level.toUpperCase()}] [${prefix}]${RESET} ${msg}`;
		// All logs go to stderr — stdout is reserved for MCP stdio transport
		console.error(line, data !== undefined ? data : "");
	}

	return {
		debug: (msg, data) => emit("debug", msg, data),
		info: (msg, data) => emit("info", msg, data),
		warn: (msg, data) => emit("warn", msg, data),
		error: (msg, data) => emit("error", msg, data),
	};
}
