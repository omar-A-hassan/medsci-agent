import { defineTool } from "@medsci/core";
import { z } from "zod";
import {
  applyOptionalSynthesis,
  fetchJsonOrError,
  needsSynthesizedSummaryField,
  normalizeDoi,
} from "./shared";

const OPENALEX_BASE = "https://api.openalex.org";

export const searchOpenAlex = defineTool({
  name: "search_openalex",
  description:
    "Search OpenAlex for scholarly metadata across disciplines. Returns titles, authors, citation counts, open-access flags, and concept tags.",
  schema: z.object({
    query: z.string().min(1).describe("Search query for scholarly works"),
    max_results: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe("Max results (default: 10)"),
    sort: z
      .enum(["relevance", "cited_by_count", "publication_date"])
      .optional()
      .describe("Sort order (default: relevance)"),
    needs_synthesized_summary: needsSynthesizedSummaryField,
  }),
  execute: async (input, ctx) => {
    const perPage = input.max_results ?? 10;
    const sortParam =
      input.sort === "cited_by_count"
        ? "cited_by_count:desc"
        : input.sort === "publication_date"
          ? "publication_date:desc"
          : "relevance_score:desc";

    const mailto = process.env.MEDSCI_OPENALEX_EMAIL ?? "medsci-agent@example.com";
    const url = `${OPENALEX_BASE}/works?search=${encodeURIComponent(input.query)}&per_page=${perPage}&sort=${sortParam}&mailto=${mailto}`;

    const response = await fetchJsonOrError<any>(url, "OpenAlex API returned", {
      timeoutMs: 15_000,
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return { success: false, error: response.error };
    }

    const works = response.data.results ?? [];
    const results = works.map((work: any) => ({
      id: work.id,
      title: work.title,
      authors: work.authorships
        ?.slice(0, 5)
        ?.map((a: any) => a.author?.display_name)
        .filter(Boolean),
      publication_date: work.publication_date,
      journal: work.primary_location?.source?.display_name,
      doi: normalizeDoi(work.doi),
      cited_by_count: work.cited_by_count,
      is_open_access: work.open_access?.is_oa,
      concepts: work.concepts?.slice(0, 5)?.map((c: any) => c.display_name),
    }));

    const openalexData = {
      query: input.query,
      total_count: response.data.meta?.count,
      n_results: results.length,
      results,
      content_level: "metadata",
    };

    const data = await applyOptionalSynthesis(
      ctx,
      input.needs_synthesized_summary ?? true,
      openalexData,
      results.map((r: any) => ({
        title: r.title,
        journal: r.journal,
        cited_by_count: r.cited_by_count,
        doi: r.doi,
      })),
      `Synthesize the research landscape for "${input.query}" from these OpenAlex metadata results. ` +
        "Call out highly cited findings and emerging trends while noting evidence is metadata-level.",
    );

    return {
      success: true,
      data,
    };
  },
});
