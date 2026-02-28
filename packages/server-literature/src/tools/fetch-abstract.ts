import { defineTool, interpretWithMedGemma } from "@medsci/core";
import { resilientFetch } from "@medsci/core/src/utils";
import { z } from "zod";
import { EUTILS_BASE } from "../constants";

export const fetchAbstract = defineTool({
	name: "fetch_abstract",
	description:
		"Fetch the full abstract and metadata for a PubMed article by PMID. Returns title, abstract text, MeSH terms, and citation information.",
	schema: z.object({
		pmid: z.string().min(1).describe("PubMed ID (e.g. '34567890')"),
		needs_synthesized_summary: z
			.boolean()
			.optional()
			.default(true)
			.describe(
				"Set to false to bypass MedGemma context summarization and return raw data",
			),
	}),
	execute: async (input, ctx) => {
		const url = `${EUTILS_BASE}/efetch.fcgi?db=pubmed&id=${input.pmid}&rettype=abstract&retmode=xml`;
		const res = await resilientFetch(url, {
			signal: AbortSignal.timeout(10_000),
			maxRetries: 3,
		});

		if (!res.ok) {
			return { success: false, error: `PubMed fetch failed: ${res.status}` };
		}

		const xml = await res.text();

		// Regex-based XML extraction. Acceptable here because PubMed eFetch XML
		// uses a flat, predictable schema with no nested same-name tags or CDATA.
		// A full XML parser would add a dependency for no practical benefit.
		const extract = (tag: string): string => {
			const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
			return match?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";
		};

		const extractAll = (tag: string): string[] => {
			const matches = xml.matchAll(
				new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g"),
			);
			return [...matches].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
		};

		const title = extract("ArticleTitle");
		const abstract = extract("AbstractText") || extract("Abstract");
		const journal = extract("Title");
		const year = extract("Year");
		const meshTerms = extractAll("DescriptorName");

		const articleData = {
			pmid: input.pmid,
			title,
			abstract,
			journal,
			year,
			mesh_terms: meshTerms.slice(0, 20),
		};

		if (!input.needs_synthesized_summary) {
			return {
				success: true,
				data: { ...articleData, interpretation: "", model_used: false },
			};
		}

		const { interpretation, model_used } = await interpretWithMedGemma(
			ctx,
			{ title, abstract },
			"Extract the key findings, methods, and clinical relevance from this article. " +
				"Highlight any novel contributions and potential impact on patient care.",
		);

		return {
			success: true,
			data: { ...articleData, interpretation, model_used },
		};
	},
});
