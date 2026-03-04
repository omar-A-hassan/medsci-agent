import { defineTool } from "@medsci/core";
import { z } from "zod";
import { EUTILS_BASE } from "../constants";
import {
  applyOptionalSynthesis,
  extractPubmedDoi,
  fetchJsonOrError,
  needsSynthesizedSummaryField,
} from "./shared";

export const searchPubmed = defineTool({
  name: "search_pubmed",
  description:
    "Search PubMed for biomedical literature metadata. Returns titles, authors, journal, publication date, article type, and DOI when available.",
  schema: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        "PubMed search query (supports Boolean operators and MeSH terms)",
      ),
    max_results: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe("Maximum results (default: 10)"),
    sort: z
      .enum(["relevance", "date"])
      .optional()
      .describe("Sort order (default: relevance)"),
    needs_synthesized_summary: needsSynthesizedSummaryField,
  }),
  execute: async (input, ctx) => {
    const maxResults = input.max_results ?? 10;
    const sort = input.sort === "date" ? "date" : "relevance";

    const searchUrl = `${EUTILS_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(input.query)}&retmax=${maxResults}&sort=${sort}&retmode=json`;

    const searchResponse = await fetchJsonOrError<any>(
      searchUrl,
      "PubMed search failed",
      { timeoutMs: 10_000 },
    );

    if (!searchResponse.ok) {
      return {
        success: false,
        error: searchResponse.error,
      };
    }

    const ids: string[] = searchResponse.data.esearchresult?.idlist ?? [];
    if (ids.length === 0) {
      return {
        success: true,
        data: {
          query: input.query,
          n_results: 0,
          articles: [] as any[],
          content_level: "metadata",
        },
      };
    }

    const fetchUrl = `${EUTILS_BASE}/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`;
    const summaryResponse = await fetchJsonOrError<any>(
      fetchUrl,
      "PubMed fetch failed",
      { timeoutMs: 10_000 },
    );

    if (!summaryResponse.ok) {
      return {
        success: false,
        error: summaryResponse.error,
      };
    }

    const articles = ids.map((pmid) => {
      const article = summaryResponse.data.result?.[pmid];
      if (!article) {
        return { pmid };
      }

      return {
        pmid,
        title: article.title,
        authors: article.authors?.map((a: any) => a.name)?.slice(0, 5) ?? [],
        journal: article.source,
        pub_date: article.pubdate,
        doi: extractPubmedDoi(article),
        article_type: article.pubtype,
      };
    });

    const pubmedData = {
      query: input.query,
      n_results: articles.length,
      articles,
      content_level: "metadata",
    };

    const data = await applyOptionalSynthesis(
      ctx,
      input.needs_synthesized_summary ?? true,
      pubmedData,
      articles.map((a) => ({ title: a.title, journal: a.journal, doi: a.doi })),
      `Synthesize key themes and findings from these PubMed metadata results for "${input.query}". ` +
        "Highlight consensus and conflicting directions while noting that this is metadata-level evidence.",
    );

    return {
      success: true,
      data,
    };
  },
});
