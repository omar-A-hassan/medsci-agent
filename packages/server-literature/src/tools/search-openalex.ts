import { z } from "zod";
import { defineTool } from "@medsci/core";

const OPENALEX_BASE = "https://api.openalex.org";

export const searchOpenAlex = defineTool({
  name: "search_openalex",
  description:
    "Search OpenAlex for scholarly works across all disciplines. Returns articles, citations, open access status, and concept tags. Good for broad literature discovery and citation analysis.",
  schema: z.object({
    query: z.string().min(1).describe("Search query for scholarly works"),
    max_results: z.number().int().positive().max(50).optional().describe("Max results (default: 10)"),
    sort: z.enum(["relevance", "cited_by_count", "publication_date"]).optional()
      .describe("Sort order (default: relevance)"),
  }),
  execute: async (input, ctx) => {
    const perPage = input.max_results ?? 10;
    const sortParam = input.sort === "cited_by_count"
      ? "cited_by_count:desc"
      : input.sort === "publication_date"
        ? "publication_date:desc"
        : "relevance_score:desc";

    // NOTE: mailto enables OpenAlex "polite pool" (faster rate limits, priority during outages).
    // Replace with a real contact email for production use.
    const mailto = process.env.MEDSCI_OPENALEX_EMAIL ?? "medsci-agent@example.com";
    const url = `${OPENALEX_BASE}/works?search=${encodeURIComponent(input.query)}&per_page=${perPage}&sort=${sortParam}&mailto=${mailto}`;

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return { success: false, error: `OpenAlex API returned ${res.status}` };
    }

    const json = (await res.json()) as any;
    const works = json.results ?? [];

    const results = works.map((work: any) => ({
      id: work.id,
      title: work.title,
      authors: work.authorships
        ?.slice(0, 5)
        ?.map((a: any) => a.author?.display_name)
        .filter(Boolean),
      publication_date: work.publication_date,
      journal: work.primary_location?.source?.display_name,
      doi: work.doi,
      cited_by_count: work.cited_by_count,
      is_open_access: work.open_access?.is_oa,
      concepts: work.concepts?.slice(0, 5)?.map((c: any) => c.display_name),
    }));

    return {
      success: true,
      data: {
        query: input.query,
        total_count: json.meta?.count,
        n_results: results.length,
        results,
      },
    };
  },
});
