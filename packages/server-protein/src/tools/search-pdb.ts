import { defineTool, interpretWithMedGemma } from "@medsci/core";
import { z } from "zod";

const PDB_SEARCH_URL = "https://search.rcsb.org/rcsbsearch/v2/query";
const PDB_DATA_URL = "https://data.rcsb.org/rest/v1/core/entry";

export const searchPdb = defineTool({
	name: "search_pdb",
	description:
		"Search the RCSB Protein Data Bank for 3D structures. Find structures by protein name, gene, organism, or PDB ID. Returns resolution, method, and ligand information.",
	schema: z.object({
		query: z
			.string()
			.min(1)
			.describe("Search query: protein name, gene, or PDB ID (e.g. '4HHB')"),
		limit: z
			.number()
			.int()
			.positive()
			.max(25)
			.optional()
			.describe("Max results (default: 10)"),
	}),
	execute: async (input, ctx) => {
		const limit = input.limit ?? 10;

		// Check if this looks like a direct PDB ID (4 characters, starts with digit)
		if (/^\d\w{3}$/.test(input.query.trim())) {
			const pdbId = input.query.trim().toUpperCase();
			const res = await fetch(`${PDB_DATA_URL}/${pdbId}`, {
				signal: AbortSignal.timeout(10_000),
			});
			if (res.ok) {
				const entry = (await res.json()) as any;
				const directResult = [
					{
						pdb_id: pdbId,
						title: entry.struct?.title,
						method: entry.exptl?.[0]?.method,
						resolution: entry.rcsb_entry_info?.resolution_combined?.[0],
						release_date: entry.rcsb_accession_info?.initial_release_date,
						polymer_count: entry.rcsb_entry_info?.polymer_entity_count,
					},
				];

				const { interpretation, model_used } = await interpretWithMedGemma(
					ctx,
					directResult,
					`Describe the structural significance of PDB entry ${pdbId}. ` +
						"Comment on resolution quality, experimental method, and potential for structure-based drug design.",
				);

				return {
					success: true,
					data: { results: directResult, interpretation, model_used },
				};
			}
		}

		// Full-text search
		const searchBody = {
			query: {
				type: "terminal",
				service: "full_text",
				parameters: { value: input.query },
			},
			return_type: "entry",
			request_options: {
				paginate: { start: 0, rows: limit },
				scoring_strategy: "combined",
			},
		};

		const res = await fetch(PDB_SEARCH_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(searchBody),
			signal: AbortSignal.timeout(15_000),
		});

		if (!res.ok) {
			return { success: false, error: `PDB search returned ${res.status}` };
		}

		const json = (await res.json()) as {
			result_set: Array<{ identifier: string; score: number }>;
		};
		const ids = json.result_set?.map((r) => r.identifier) ?? [];

		// Fetch details for top results
		const results = await Promise.all(
			ids.slice(0, limit).map(async (pdbId) => {
				try {
					const detailRes = await fetch(`${PDB_DATA_URL}/${pdbId}`, {
						signal: AbortSignal.timeout(5_000),
					});
					if (!detailRes.ok) return { pdb_id: pdbId };
					const entry = (await detailRes.json()) as any;
					return {
						pdb_id: pdbId,
						title: entry.struct?.title,
						method: entry.exptl?.[0]?.method,
						resolution: entry.rcsb_entry_info?.resolution_combined?.[0],
						release_date: entry.rcsb_accession_info?.initial_release_date,
					};
				} catch {
					return { pdb_id: pdbId };
				}
			}),
		);

		const pdbData = { query: input.query, n_results: results.length, results };

		const { interpretation, model_used } = await interpretWithMedGemma(
			ctx,
			results,
			`Assess the structural data for "${input.query}". ` +
				"Comment on resolution quality, experimental methods, and druggability of the structures found.",
		);

		return {
			success: true,
			data: { ...pdbData, interpretation, model_used },
		};
	},
});
