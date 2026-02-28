import { defineTool, interpretWithMedGemma } from "@medsci/core";
import { z } from "zod";

const CHEMBL_BASE = "https://www.ebi.ac.uk/chembl/api/data";

export const searchChembl = defineTool({
	name: "search_chembl",
	description:
		"Search the ChEMBL database for bioactive molecules. Find compounds by target, molecule name, or similar structure. Returns bioactivity data, assay results, and compound information.",
	schema: z.object({
		query: z
			.string()
			.min(1)
			.describe(
				"Search query: target name, molecule name, or SMILES for similarity",
			),
		search_type: z
			.enum(["target", "molecule", "similarity"])
			.optional()
			.describe("Type of search (default: molecule)"),
		limit: z
			.number()
			.int()
			.positive()
			.max(50)
			.optional()
			.describe("Max results (default: 10)"),
	}),
	execute: async (input, ctx) => {
		const limit = input.limit ?? 10;
		const searchType = input.search_type ?? "molecule";

		let url: string;
		switch (searchType) {
			case "target":
				url = `${CHEMBL_BASE}/target/search.json?q=${encodeURIComponent(input.query)}&limit=${limit}`;
				break;
			case "similarity":
				url = `${CHEMBL_BASE}/similarity/${encodeURIComponent(input.query)}/70.json?limit=${limit}`;
				break;
			default:
				url = `${CHEMBL_BASE}/molecule/search.json?q=${encodeURIComponent(input.query)}&limit=${limit}`;
		}

		const res = await fetch(url, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});

		if (!res.ok) {
			return {
				success: false,
				error: `ChEMBL API returned ${res.status}: ${res.statusText}`,
			};
		}

		const json = await res.json();
		const items =
			(json as any)[searchType === "target" ? "targets" : "molecules"] ?? [];

		const results = items.slice(0, limit).map((item: any) => {
			if (searchType === "target") {
				return {
					chembl_id: item.target_chembl_id,
					name: item.pref_name,
					organism: item.organism,
					target_type: item.target_type,
				};
			}
			return {
				chembl_id: item.molecule_chembl_id,
				name: item.pref_name,
				max_phase: item.max_phase,
				molecule_type: item.molecule_type,
				smiles: item.molecule_structures?.canonical_smiles,
				molecular_weight: item.molecule_properties?.full_mwt,
			};
		});

		const chemblData = {
			search_type: searchType,
			query: input.query,
			n_results: results.length,
			results,
		};

		const { interpretation, model_used } = await interpretWithMedGemma(
			ctx,
			results,
			`Analyze these ChEMBL ${searchType} results for "${input.query}". ` +
				"Summarize compound potency, selectivity patterns, and development stage. " +
				"Flag any PAINS or structural alerts if SMILES are available.",
		);

		return {
			success: true,
			data: { ...chemblData, interpretation, model_used },
		};
	},
});
