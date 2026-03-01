import { join } from "node:path";
import { PythonSidecar, defineTool } from "@medsci/core";
import { z } from "zod";

// Initialize a dedicated sidecar purely for the PaperQA server
// It points to the isolated internal python script managing the PQA execution environment
const pqaSidecarPath = join(import.meta.dir, "../../python/paperqa_server.py");

// Create the sidecar instance but do not start it yet.
// Server factories typically handle lifecycle, but we export the tool directly.
export const pqaSidecar = new PythonSidecar({
	scriptPath: pqaSidecarPath,
	pythonBin: join(import.meta.dir, "../../.venv-paperqa/bin/python3"),
	timeoutMs: 120_000, // 2 minutes due to heavy PDF parsing/ranking
});

// Explicit IPC Error Mapper (Issue 3 resolution from Blueprint)
function mapPaperQaError(error: any): string {
	const msg = String(error);

	if (msg.includes("RateLimitExceeded")) {
		return "API rate limit reached (likely Semantic Scholar). Wait and retry with fewer papers.";
	}
	if (msg.includes("TantivyLockError")) {
		return "Tantivy index is locked by another process. The previous agent request may still be indexing.";
	}
	if (msg.includes("pdfminer.pdfparser.PDFSyntaxError")) {
		return "One of the provided PDFs is malformed or corrupted and cannot be indexed.";
	}
	if (msg.includes("OutOfMemory") || msg.includes("OOM")) {
		return "Out of memory error during indexing. Please submit max 3 papers at a time.";
	}
	if (msg.includes("LLMConnectionError")) {
		return "Failed to connect to the local inference server (Ollama). Check if it is running.";
	}
	if (msg.includes("ConnectError") || msg.includes("NCBI")) {
		return "Failed to reach NCBI APIs. Check network connectivity.";
	}

	// Fallback map
	return `PaperQA Agent Error: ${msg}`;
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
