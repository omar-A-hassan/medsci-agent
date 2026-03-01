import { describe, expect, test } from "bun:test";
import { getSidecarErrorEnvelope, mapSidecarError } from "../sidecar-errors";

describe("sidecar-errors", () => {
	test("extracts sidecar envelope from error object", () => {
		const err = new Error("boom");
		(err as any).sidecar = {
			error_code: "MODEL_NOT_FOUND",
			error_message: "Missing model",
			error_stage: "startup",
			retryable: false,
		};

		const env = getSidecarErrorEnvelope(err);
		expect(env?.error_code).toBe("MODEL_NOT_FOUND");
	});

	test("maps sidecar error code to user-facing message", () => {
		const err = new Error("boom");
		(err as any).sidecar = {
			error_code: "MODEL_NOT_FOUND",
			error_message: "Missing model",
		};

		const out = mapSidecarError(err, {
			MODEL_NOT_FOUND: "Configured model missing",
		});

		expect(out).toBe("Configured model missing");
	});

	test("falls back to prefix + message when code is unknown", () => {
		const out = mapSidecarError(new Error("unmapped"), {}, "PaperQA error");
		expect(out).toBe("PaperQA error: unmapped");
	});
});
