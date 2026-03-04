import { defineTool } from "@medsci/core";
import { z } from "zod";
import { EUTILS_BASE } from "../constants";
import {
  applyOptionalSynthesis,
  fetchTextOrError,
  needsSynthesizedSummaryField,
  normalizeDoi,
} from "./shared";

function parsePubmedAbstractXml(xml: string): {
  title: string;
  abstract: string;
  journal: string;
  year: string;
  meshTerms: string[];
  doi?: string;
} {
  if (typeof DOMParser === "undefined") {
    const extract = (tag: string): string => {
      const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      return match?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";
    };
    const extractAll = (tag: string): string[] => {
      const matches = xml.matchAll(
        new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi"),
      );
      return [...matches]
        .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
        .filter(Boolean);
    };
    const doiMatch = xml.match(
      /<ArticleId[^>]*IdType=["']doi["'][^>]*>([\s\S]*?)<\/ArticleId>/i,
    );

    const title = extract("ArticleTitle");
    if (!title && !xml.includes("<PubmedArticle")) {
      throw new Error("Unable to parse PubMed XML response");
    }

    const segments = extractAll("AbstractText");
    return {
      title,
      abstract:
        segments.length > 0 ? segments.join("\n\n") : extract("Abstract"),
      journal: extract("Title"),
      year: extract("Year"),
      meshTerms: extractAll("DescriptorName").slice(0, 20),
      doi: normalizeDoi(doiMatch?.[1]?.trim()),
    };
  }

  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    throw new Error("Unable to parse PubMed XML response");
  }

  const text = (selector: string): string =>
    doc.querySelector(selector)?.textContent?.trim() ?? "";

  const textAll = (selector: string): string[] =>
    [...doc.querySelectorAll(selector)]
      .map((el) => el.textContent?.trim() ?? "")
      .filter(Boolean);

  const abstractSegments = [
    ...textAll("Abstract AbstractText"),
    ...textAll("AbstractText"),
  ];
  const abstract =
    abstractSegments.length > 0 ? abstractSegments.join("\n\n") : text("Abstract");

  const doi = (() => {
    const articleIdNodes = [...doc.querySelectorAll("ArticleId")];
    const preferred = articleIdNodes.find(
      (node) => node.getAttribute("IdType")?.toLowerCase() === "doi",
    );
    return normalizeDoi(preferred?.textContent ?? undefined);
  })();

  if (!doc.querySelector("PubmedArticle, PubmedArticleSet")) {
    throw new Error("Unable to parse PubMed XML response");
  }

  return {
    title: text("ArticleTitle"),
    abstract,
    journal: text("Journal Title") || text("Title"),
    year: text("PubDate Year") || text("ArticleDate Year"),
    meshTerms: textAll("MeshHeading DescriptorName").slice(0, 20),
    doi,
  };
}

export const fetchAbstract = defineTool({
  name: "fetch_abstract",
  description:
    "Fetch abstract text and key metadata for a PubMed article by PMID. Returns abstract text, title, MeSH terms, journal, publication year, and DOI when available.",
  schema: z.object({
    pmid: z.string().min(1).describe("PubMed ID (e.g. '34567890')"),
    needs_synthesized_summary: needsSynthesizedSummaryField,
  }),
  execute: async (input, ctx) => {
    const url = `${EUTILS_BASE}/efetch.fcgi?db=pubmed&id=${encodeURIComponent(input.pmid)}&rettype=abstract&retmode=xml`;

    const response = await fetchTextOrError(url, "PubMed fetch failed", 10_000);
    if (!response.ok) {
      return {
        success: false,
        error: response.error,
      };
    }

    const parsed = parsePubmedAbstractXml(response.data);
    const articleData = {
      pmid: input.pmid,
      title: parsed.title,
      abstract: parsed.abstract,
      journal: parsed.journal,
      year: parsed.year,
      doi: parsed.doi,
      mesh_terms: parsed.meshTerms,
      content_level: "abstract",
    };

    const data = await applyOptionalSynthesis(
      ctx,
      input.needs_synthesized_summary ?? true,
      articleData,
      { title: parsed.title, abstract: parsed.abstract, doi: parsed.doi },
      "Extract key findings, methods, and clinical relevance from this abstract. " +
        "Highlight novelty and any important caveats.",
    );

    return {
      success: true,
      data,
    };
  },
});

export const __testing = {
  parsePubmedAbstractXml,
};
