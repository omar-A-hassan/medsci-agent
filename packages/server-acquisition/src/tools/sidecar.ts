import { join } from "node:path";
import { PythonSidecar, getSidecarErrorEnvelope } from "@medsci/core";

const sidecarPath = join(import.meta.dir, "../../python/acquisition_sidecar.py");
const defaultAcquisitionPython = join(
  import.meta.dir,
  "../../../server-paperqa/.venv-paperqa/bin/python3",
);

interface ExtractHtmlRpcResult {
  text?: unknown;
  title?: unknown;
  extraction_confidence?: unknown;
  extraction_backend?: unknown;
  fallback_used?: unknown;
  scrapling_version?: unknown;
}

export const acquisitionSidecar = new PythonSidecar({
  scriptPath: sidecarPath,
  pythonBin: process.env.ACQ_PYTHON ?? process.env.MEDSCI_PYTHON ?? defaultAcquisitionPython,
  timeoutMs: 60_000,
});

export async function extractHtmlText(
  html: string,
  url: string,
  requireScrapling: boolean,
): Promise<{
  text: string;
  title?: string;
  extraction_confidence: number;
  extraction_backend: "scrapling" | "beautifulsoup" | "regex";
  fallback_used: boolean;
  scrapling_version?: string;
  retrieval_method: "scrapling_html";
}> {
  if (!acquisitionSidecar.isRunning()) {
    await acquisitionSidecar.start();
  }

  try {
    const result = await acquisitionSidecar.call<ExtractHtmlRpcResult>("extract_html", {
      html,
      url,
      require_scrapling: requireScrapling,
    });
    const backendRaw = typeof result?.extraction_backend === "string" ? result.extraction_backend : "regex";
    const extractionBackend =
      backendRaw === "scrapling" || backendRaw === "beautifulsoup" || backendRaw === "regex"
        ? backendRaw
        : "regex";
    return {
      text: String(result?.text ?? ""),
      title: typeof result?.title === "string" ? result.title : undefined,
      extraction_confidence:
        typeof result?.extraction_confidence === "number"
          ? Math.max(0, Math.min(1, result.extraction_confidence))
          : 0.75,
      extraction_backend: extractionBackend,
      fallback_used: Boolean(result?.fallback_used),
      scrapling_version:
        typeof result?.scrapling_version === "string" ? result.scrapling_version : undefined,
      retrieval_method: "scrapling_html",
    };
  } catch (err) {
    const envelope = getSidecarErrorEnvelope(err);
    const reason = envelope?.error_message ?? (err as Error)?.message ?? "Sidecar extraction failed";
    throw new Error(reason);
  }
}
