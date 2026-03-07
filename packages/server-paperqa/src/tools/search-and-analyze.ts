import { join } from "node:path";
import { PythonSidecar, defineTool, mapSidecarError } from "@medsci/core";
import { z } from "zod";

const pqaSidecarPath = join(import.meta.dir, "../../python/paperqa_server.py");

export const pqaSidecar = new PythonSidecar({
  scriptPath: pqaSidecarPath,
  pythonBin: join(import.meta.dir, "../../.venv-paperqa/bin/python3"),
  timeoutMs: 150_000,
});

const PAPERQA_ERROR_MAP: Record<string, string> = {
  OLLAMA_UNREACHABLE:
    "Failed to connect to the local inference server (Ollama). Check if it is running.",
  MODEL_NOT_FOUND:
    "Configured local model was not found in Ollama. Pull the model or update PQA_LLM_MODEL/PQA_EMBEDDING_MODEL.",
  EMBEDDING_BAD_REQUEST:
    "Embedding request was rejected by the local model endpoint. Verify embedding model compatibility.",
  ACQUIRE_NONE_SUCCESS:
    "Could not acquire text for any requested papers from PMC Open Access/PubMed.",
  INDEX_ZERO_SUCCESS:
    "Paper acquisition succeeded, but indexing failed for all papers. Check local model and embedding configuration.",
  QUERY_TIMEOUT:
    "LLM query timed out. Consider increasing PQA_LLM_TIMEOUT_SECONDS or reducing PQA_EVIDENCE_K/PQA_ANSWER_MAX_SOURCES.",
  QUERY_RATE_LIMIT:
    "LLM endpoint rate-limited the request. Wait a moment and retry.",
  INVALID_DOCUMENT_INPUT:
    "One or more provided documents are invalid. Ensure each document has source_id, provenance_url, and non-empty text.",
};

export function computeTimeoutMs(itemCount: number): number {
  const baseMs = Math.min(420_000, 120_000 + Math.max(0, itemCount) * 30_000);
  const llmTimeoutSec = Number(process.env.PQA_LLM_TIMEOUT_SECONDS) || 180;
  const llmBudgetMs = (llmTimeoutSec + 45) * 1000;
  return Math.min(540_000, Math.max(baseMs, llmBudgetMs));
}

function mapPaperQaError(error: unknown): string {
  return mapSidecarError(error, PAPERQA_ERROR_MAP, "PaperQA Agent Error");
}

interface AnalyzePapersSidecarResponse {
  answer?: string;
  references?: string[] | unknown;
  context?: unknown;
  papers_indexed?: number;
  failed_downloads?: unknown;
  failed_indexing?: unknown;
  failed_acquisitions?: unknown;
  validation_errors?: unknown;
  stage_status?: unknown;
  warnings?: unknown;
  acquisition_summary?: unknown;
  error_code?: string | null;
  error_detail?: string | null;
  retryable?: boolean;
}

const paperInputSchema = z.object({
  identifier: z.string().trim().min(1).describe("DOI (e.g., '10.1038/s41586...') or PMID"),
  title: z.string().optional().describe("Pre-seeded title to bypass N+1 network lookups"),
  authors: z.array(z.string()).optional().describe("Pre-seeded authors list"),
  citation_count: z.number().optional().describe("Pre-seeded citation count"),
});

const documentInputSchema = z.object({
  source_id: z.string().min(1),
  source_type: z.enum(["doi", "pmid", "pmcid", "url"]),
  provenance_url: z.string().url(),
  retrieval_method: z.enum(["ncbi_bioc", "scrapling_html", "scrapling_pdf", "cached"]),
  license_hint: z.enum(["open_access", "unknown", "restricted"]),
  text: z.string().min(1),
  text_hash: z.string().min(8),
  metadata: z
    .object({
      title: z.string().optional(),
      authors: z.array(z.string()).optional(),
      published_at: z.string().optional(),
      journal: z.string().optional(),
      doi: z.string().optional(),
    })
    .default({}),
  extraction_confidence: z.number().min(0).max(1),
  extraction_backend: z
    .enum(["scrapling", "beautifulsoup", "regex", "pdf_text", "plain_text"])
    .optional(),
  fallback_used: z.boolean().optional(),
  policy: z.object({
    allowed: z.boolean(),
    blocked: z.boolean(),
    reason: z.string().optional(),
  }),
  content_level: z.enum(["metadata", "abstract", "full_text"]).optional(),
});

export const searchAndAnalyzeTool = defineTool({
  name: "search_and_analyze",
  description:
    "Performs deep literature analysis using PaperQA2. Accepts either DOI/PMID paper identifiers (with internal NCBI acquisition) or pre-acquired documents with provenance metadata.",
  schema: z
    .object({
      query: z.string().describe("The research question to ask against the papers"),
      papers: z
        .array(
          z.preprocess(
            (value) =>
              typeof value === "string"
                ? { identifier: value.trim() }
                : value,
            paperInputSchema,
          ),
        )
        .max(
          10,
          "STRICT LIMIT: Maximum 10 papers allowed per analysis chunk to prevent OOM/network failures.",
        )
        .optional()
        .default([])
        .describe("Paper identifiers for internal acquisition. Accepts objects or legacy string identifiers."),
      documents: z
        .array(documentInputSchema)
        .max(
          10,
          "STRICT LIMIT: Maximum 10 documents allowed per analysis chunk to prevent OOM/network failures.",
        )
        .optional()
        .default([])
        .describe("Pre-acquired documents. If provided, PaperQA skips internal acquisition."),
    })
    .superRefine((value, issue) => {
      if ((value.documents?.length ?? 0) === 0 && (value.papers?.length ?? 0) === 0) {
        issue.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Provide at least one paper identifier or one acquired document.",
          path: ["papers"],
        });
      }
    }),
  execute: async (input) => {
    try {
      const documentCount = input.documents?.length ?? 0;
      const paperCount = input.papers?.length ?? 0;
      const itemCount =
        documentCount > 0 ? documentCount : paperCount;

      pqaSidecar.setTimeoutMs(computeTimeoutMs(itemCount));

      if (!pqaSidecar.isRunning()) {
        await pqaSidecar.start();
      }

      const result = await pqaSidecar.call<AnalyzePapersSidecarResponse>("analyze_papers", {
        query: input.query,
        papers: input.papers ?? [],
        documents: input.documents ?? [],
        workspace_dir: process.cwd(),
        prefer_documents: documentCount > 0,
      });

      return {
        success: true,
        data: result,
      };
    } catch (e: unknown) {
      return {
        success: false,
        error: mapPaperQaError(e),
      };
    }
  },
});
