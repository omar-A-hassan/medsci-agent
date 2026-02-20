import { z } from "zod";
import { defineTool, interpretWithMedGemma } from "@medsci/core";
import { EUTILS_BASE } from "../constants";

export const searchPubmed = defineTool({
  name: "search_pubmed",
  description:
    "Search PubMed for biomedical literature. Returns article titles, abstracts, authors, DOIs, and publication dates. Supports advanced Boolean and MeSH queries.",
  schema: z.object({
    query: z.string().min(1).describe("PubMed search query (supports Boolean: AND, OR, NOT and MeSH terms)"),
    max_results: z.number().int().positive().max(50).optional().describe("Maximum results (default: 10)"),
    sort: z.enum(["relevance", "date"]).optional().describe("Sort order (default: relevance)"),
  }),
  execute: async (input, ctx) => {
    const maxResults = input.max_results ?? 10;
    const sort = input.sort === "date" ? "date" : "relevance";

    // Step 1: Search for PMIDs
    const searchUrl = `${EUTILS_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(input.query)}&retmax=${maxResults}&sort=${sort}&retmode=json`;
    const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(10_000) });
    if (!searchRes.ok) {
      return { success: false, error: `PubMed search failed: ${searchRes.status}` };
    }
    const searchData = (await searchRes.json()) as any;
    const ids: string[] = searchData.esearchresult?.idlist ?? [];

    if (ids.length === 0) {
      return { success: true, data: { query: input.query, n_results: 0, articles: [] } };
    }

    // Step 2: Fetch article details
    const fetchUrl = `${EUTILS_BASE}/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`;
    const fetchRes = await fetch(fetchUrl, { signal: AbortSignal.timeout(10_000) });
    if (!fetchRes.ok) {
      return { success: false, error: `PubMed fetch failed: ${fetchRes.status}` };
    }
    const fetchData = (await fetchRes.json()) as any;

    const articles = ids.map((pmid) => {
      const article = fetchData.result?.[pmid];
      if (!article) return { pmid };
      return {
        pmid,
        title: article.title,
        authors: article.authors?.map((a: any) => a.name)?.slice(0, 5),
        journal: article.source,
        pub_date: article.pubdate,
        doi: article.elocationid,
        article_type: article.pubtype,
      };
    });

    const pubmedData = { query: input.query, n_results: articles.length, articles };

    const { interpretation, model_used } = await interpretWithMedGemma(
      ctx,
      articles.map((a) => ({ title: a.title, journal: a.journal })),
      `Synthesize the key themes and findings from these PubMed results for "${input.query}". ` +
        "What are the main research trends? Any consensus or conflicting findings?",
    );

    return {
      success: true,
      data: { ...pubmedData, interpretation, model_used },
    };
  },
});
