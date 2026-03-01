import { join } from "node:path";
import { PythonSidecar, defineTool, mapSidecarError } from "@medsci/core";
import { z } from "zod";

// Initialize a dedicated sidecar purely for the PaperQA server
// It points to the isolated internal python script managing the PQA execution environment
const pqaSidecarPath = join(import.meta.dir, "../../python/paperqa_server.py");

// Create the sidecar instance but do not start it yet.
// Server factories typically handle lifecycle, but we export the tool directly.
export const pqaSidecar = new PythonSidecar({
	scriptPath: pqaSidecarPath,
	pythonBin: join(import.meta.dir, "../../.venv-paperqa/bin/python3"),
	timeoutMs: 150_000, // runtime-adjusted per request in execute()
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
};

/**
 * Compute sidecar timeout enforcing: LLM timeout < sidecar timeout < MCP timeout (600s).
 *
 * - baseMs: scales with paper count (120s + 30s/paper, capped at 420s)
 * - llmBudgetMs: LLM timeout + 45s headroom for acquire/index overhead
 * - Result: max of both, capped at 540s (leaving 60s margin below MCP's 600s)
 */
export function computeTimeoutMs(paperCount: number): number {
	const baseMs = Math.min(420_000, 120_000 + Math.max(0, paperCount) * 30_000);
	const llmTimeoutSec = Number(process.env.PQA_LLM_TIMEOUT_SECONDS) || 180;
	const llmBudgetMs = (llmTimeoutSec + 45) * 1000;
	return Math.min(540_000, Math.max(baseMs, llmBudgetMs));
}

function mapPaperQaError(error: unknown): string {
	return mapSidecarError(error, PAPERQA_ERROR_MAP, "PaperQA Agent Error");
}

export const searchAndAnalyzeTool = defineTool({
	name: "search_and_analyze",
	description:
		"Performs deep literature analysis using PaperQA2. Acquires full text via NCBI BioC API for the provided DOIs/PMIDs (with abstract fallback), indexes them locally with Tantivy, and uses a Re-ranking Contextual LLM strategy to generate a heavily cited answer to your query.",
	schema: z.object({
		query: z
			.string()
			.describe("The research question to ask against the papers"),
		papers: z
			.array(
				z.object({
					identifier: z
						.string()
						.describe("DOI (e.g., '10.1038/s41586...') or PMID"),
					title: z
						.string()
						.optional()
						.describe("Pre-seeded title to bypass N+1 network lookups"),
					authors: z
						.array(z.string())
						.optional()
						.describe("Pre-seeded authors list"),
					citation_count: z
						.number()
						.optional()
						.describe("Pre-seeded citation count"),
				}),
			)
			.max(
				10,
				"STRICT LIMIT: Maximum 10 papers allowed per analysis chunk to prevent OOM/network failures.",
			)
			.describe(
				"List of papers to analyze. Pass metadata if discovered from OpenAlex/PubMed first.",
			),
	}),
	execute: async (input, ctx) => {
		try {
			pqaSidecar.setTimeoutMs(computeTimeoutMs(input.papers.length));

			if (!pqaSidecar.isRunning()) {
				await pqaSidecar.start();
			}

			// Relay the execution down to the Python sidecar handler using IPC
			const result = await pqaSidecar.call<any>("analyze_papers", {
				query: input.query,
				papers: input.papers,
				workspace_dir: process.cwd(), // Forwarded to ensure absolute index/cache mapping
			});

			return {
				success: true,
				data: result,
			};
		} catch (e: any) {
			return {
				success: false,
				error: mapPaperQaError(e),
			};
		}
	},
});
