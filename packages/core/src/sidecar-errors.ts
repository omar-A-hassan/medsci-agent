import type { SidecarErrorEnvelope } from "./types";

export interface SidecarErrorMap {
	[key: string]: string;
}

export function getSidecarErrorEnvelope(
	error: unknown,
): SidecarErrorEnvelope | null {
	if (!error || typeof error !== "object") {
		return null;
	}

	const maybeSidecar = (error as any).sidecar;
	if (!maybeSidecar || typeof maybeSidecar !== "object") {
		return null;
	}

	return maybeSidecar as SidecarErrorEnvelope;
}

export function mapSidecarError(
	error: unknown,
	codeMap: SidecarErrorMap,
	fallbackPrefix = "Sidecar error",
): string {
	const envelope = getSidecarErrorEnvelope(error);
	if (envelope?.error_code && codeMap[envelope.error_code]) {
		return codeMap[envelope.error_code];
	}

	const message =
		envelope?.error_message ??
		(error instanceof Error ? error.message : String(error));
	return `${fallbackPrefix}: ${message}`;
}
