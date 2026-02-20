import { z } from "zod";
import { defineTool, interpretWithMedGemma } from "@medsci/core";

export const geneSetEnrichment = defineTool({
  name: "gene_set_enrichment",
  description:
    "Perform gene set enrichment analysis on a list of genes. Queries Enrichr or GSEA against MSigDB, GO, KEGG pathways to identify enriched biological processes.",
  schema: z.object({
    genes: z.array(z.string()).min(1).describe("List of gene symbols"),
    gene_set_library: z.string().optional().describe("Gene set library (default: GO_Biological_Process_2023)"),
  }),
  execute: async (input, ctx) => {
    // Enrichr API — no Python dependency needed, pure HTTP
    const library = input.gene_set_library ?? "GO_Biological_Process_2023";

    // Step 1: Submit gene list
    const submitRes = await fetch("https://maayanlab.cloud/Enrichr/addList", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        list: input.genes.join("\n"),
        description: "MedSci agent query",
      }),
    });
    if (!submitRes.ok) {
      return { success: false, error: `Enrichr submit failed: ${submitRes.status}` };
    }
    const { userListId } = (await submitRes.json()) as { userListId: number };

    // Step 2: Fetch enrichment results
    const resultRes = await fetch(
      `https://maayanlab.cloud/Enrichr/enrich?userListId=${userListId}&backgroundType=${library}`,
    );
    if (!resultRes.ok) {
      return { success: false, error: `Enrichr query failed: ${resultRes.status}` };
    }
    const raw = (await resultRes.json()) as Record<string, unknown[][]>;
    const entries = raw[library] ?? [];

    const results = entries.slice(0, 20).map((row: unknown[]) => ({
      term: String(row[1]),
      p_value: Number(row[2]),
      adjusted_p_value: Number(row[6]),
      overlap: String(row[3]),
      genes: (row[5] as string[]) ?? [],
    }));

    const enrichmentData = {
      library,
      n_input_genes: input.genes.length,
      n_enriched_terms: results.length,
      results,
    };

    const { interpretation, model_used } = await interpretWithMedGemma(
      ctx,
      results.slice(0, 10),
      `Summarize what these enriched ${library} terms tell us about the underlying biology. ` +
        "What are the key pathways and processes? Any clinical or therapeutic implications?",
    );

    return {
      success: true,
      data: { ...enrichmentData, interpretation, model_used },
    };
  },
});
