import type { AcquiredDocument, AcquisitionPolicyDecision } from "@medsci/core";

export const AcquisitionErrorCodes = {
	INVALID_TARGET: "INVALID_TARGET",
	UNRESOLVED_SOURCE: "UNRESOLVED_SOURCE",
	BLOCKED_BY_POLICY: "BLOCKED_BY_POLICY",
	DNS_BLOCKED: "DNS_BLOCKED",
	REDIRECT_WITHOUT_LOCATION: "REDIRECT_WITHOUT_LOCATION",
	TOO_MANY_REDIRECTS: "TOO_MANY_REDIRECTS",
	MIME_NOT_ALLOWED: "MIME_NOT_ALLOWED",
	CONTENT_TOO_LARGE: "CONTENT_TOO_LARGE",
	EXTRACTION_FAILED: "EXTRACTION_FAILED",
	SCRAPLING_REQUIRED: "SCRAPLING_REQUIRED",
	SIDECAR_DEPENDENCY_MISSING: "SIDECAR_DEPENDENCY_MISSING",
	NETWORK_ERROR: "NETWORK_ERROR",
	ACQUISITION_FAILED: "ACQUISITION_FAILED",
} as const;

export type AcquisitionErrorCode =
	(typeof AcquisitionErrorCodes)[keyof typeof AcquisitionErrorCodes];

export class AcquisitionError extends Error {
	readonly code: AcquisitionErrorCode;
	readonly retryable: boolean;
	readonly blocked: boolean;

	constructor(
		code: AcquisitionErrorCode,
		message: string,
		opts?: { retryable?: boolean; blocked?: boolean },
	) {
		super(message);
		this.name = "AcquisitionError";
		this.code = code;
		this.retryable = opts?.retryable ?? false;
		this.blocked = opts?.blocked ?? false;
	}
}

export interface AcquisitionResultRecord {
	target: string;
	normalized?: { kind: string; canonical: string };
	status: "acquired" | "blocked" | "failed";
	policy: AcquisitionPolicyDecision;
	retryable: boolean;
	error_code?: AcquisitionErrorCode;
	error_detail?: string;
	source_url?: string;
	document?: AcquiredDocument;
}

export function buildAcquiredResult(input: {
	target: string;
	normalized: { kind: string; canonical: string };
	document: AcquiredDocument;
	sourceUrl?: string;
}): AcquisitionResultRecord {
	return {
		target: input.target,
		normalized: input.normalized,
		status: "acquired",
		policy: { allowed: true, blocked: false },
		retryable: false,
		source_url: input.sourceUrl ?? input.document.provenance_url,
		document: input.document,
	};
}

export function buildBlockedResult(input: {
	target: string;
	normalized?: { kind: string; canonical: string };
	reason: string;
	errorCode?: AcquisitionErrorCode;
	retryable?: boolean;
}): AcquisitionResultRecord {
	return {
		target: input.target,
		normalized: input.normalized,
		status: "blocked",
		policy: { allowed: false, blocked: true, reason: input.reason },
		retryable: input.retryable ?? false,
		error_code: input.errorCode ?? AcquisitionErrorCodes.BLOCKED_BY_POLICY,
		error_detail: input.reason,
	};
}

export function buildFailedResult(input: {
	target: string;
	normalized?: { kind: string; canonical: string };
	errorCode: AcquisitionErrorCode;
	errorDetail: string;
	retryable?: boolean;
	policy?: AcquisitionPolicyDecision;
}): AcquisitionResultRecord {
	return {
		target: input.target,
		normalized: input.normalized,
		status: "failed",
		policy:
			input.policy ??
			({
				allowed: true,
				blocked: false,
			} satisfies AcquisitionPolicyDecision),
		retryable: input.retryable ?? false,
		error_code: input.errorCode,
		error_detail: input.errorDetail,
	};
}

export function toAcquisitionError(err: unknown): AcquisitionError {
	if (err instanceof AcquisitionError) return err;
	const message = err instanceof Error ? err.message : String(err);
	const lowered = message.toLowerCase();

	if (message.includes("SCRAPLING_REQUIRED")) {
		return new AcquisitionError(AcquisitionErrorCodes.SIDECAR_DEPENDENCY_MISSING, message, {
			retryable: false,
		});
	}

	if (message.includes("MIME_NOT_ALLOWED")) {
		return new AcquisitionError(AcquisitionErrorCodes.MIME_NOT_ALLOWED, message);
	}

	if (message.includes("CONTENT_TOO_LARGE")) {
		return new AcquisitionError(AcquisitionErrorCodes.CONTENT_TOO_LARGE, message);
	}

	if (message.includes("TOO_MANY_REDIRECTS")) {
		return new AcquisitionError(AcquisitionErrorCodes.TOO_MANY_REDIRECTS, message, {
			retryable: true,
		});
	}

	if (lowered.includes("timed out") || lowered.includes("timeout")) {
		return new AcquisitionError(AcquisitionErrorCodes.NETWORK_ERROR, message, {
			retryable: true,
		});
	}

	if (
		message.includes("Fetch failed")
		|| lowered.includes("network")
		|| lowered.includes("econn")
		|| lowered.includes("enotfound")
	) {
		return new AcquisitionError(AcquisitionErrorCodes.NETWORK_ERROR, message, {
			retryable: true,
		});
	}

	return new AcquisitionError(AcquisitionErrorCodes.ACQUISITION_FAILED, message);
}
