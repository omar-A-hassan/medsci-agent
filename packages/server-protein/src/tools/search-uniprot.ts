import { z } from "zod";
import { defineTool, interpretWithMedGemma } from "@medsci/core";

const UNIPROT_BASE = "https://rest.uniprot.org/uniprotkb";

export const searchUniprot = defineTool({
  name: "search_uniprot",
  description:
    "Search the UniProt protein database. Find proteins by name, gene, organism, or accession. Returns protein function, sequence, and annotation data.",
  schema: z.object({
    query: z.string().min(1).describe("Search query: protein name, gene symbol, or UniProt accession"),
    organism: z.string().optional().describe("Filter by organism (e.g. 'human', '9606')"),
    limit: z.number().int().positive().max(25).optional().describe("Max results (default: 10)"),
  }),
  execute: async (input, ctx) => {
    const limit = input.limit ?? 10;
    let query = input.query;
    if (input.organism) {
      query += ` AND organism_name:${input.organism}`;
    }

    const url = `${UNIPROT_BASE}/search?query=${encodeURIComponent(query)}&format=json&size=${limit}&fields=accession,protein_name,gene_names,organism_name,length,sequence`;

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return { success: false, error: `UniProt API returned ${res.status}` };
    }

    const json = (await res.json()) as { results: any[] };

    const results = json.results.map((entry: any) => ({
      accession: entry.primaryAccession,
      name: entry.proteinDescription?.recommendedName?.fullName?.value ?? "Unknown",
      gene: entry.genes?.[0]?.geneName?.value ?? "Unknown",
      organism: entry.organism?.scientificName ?? "Unknown",
      length: entry.sequence?.length,
      sequence_preview: entry.sequence?.value?.slice(0, 80),
    }));

    const uniprotData = { query: input.query, n_results: results.length, results };

    const { interpretation, model_used } = await interpretWithMedGemma(
      ctx,
      results,
      `Summarize the functions and clinical relevance of these proteins found for "${input.query}". ` +
        "Highlight any disease associations or therapeutic targets.",
    );

    return {
      success: true,
      data: { ...uniprotData, interpretation, model_used },
    };
  },
});
