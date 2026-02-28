import { afterEach, describe, expect, mock, test } from "bun:test";
import { createMockContext } from "@medsci/core";
import { predictStructure } from "../tools/predict-structure";
import { searchPdb } from "../tools/search-pdb";
import { searchUniprot } from "../tools/search-uniprot";
import { sequenceAnalysis } from "../tools/sequence-analysis";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("analyze_sequence", () => {
	test("returns sequence stats with interpretation", async () => {
		const ctx = createMockContext({
			pythonResponse: {
				length: 150,
				composition: { A: 10, G: 20 },
				molecular_weight: 16500.5,
				seq_type: "protein",
			},
		});
		const result = await sequenceAnalysis.execute(
			{ sequence: "MKTLLILAVF" },
			ctx,
		);
		expect(result.success).toBe(true);
		expect(result.data?.length).toBe(150);
		expect(result.data?.interpretation).toBeDefined();
		expect(result.data?.model_used).toBe(true);
	});

	test("calls biopython.sequence_stats with correct args", async () => {
		const ctx = createMockContext({
			pythonResponse: { length: 10, composition: {}, seq_type: "DNA" },
		});
		await sequenceAnalysis.execute(
			{ sequence: "ATCGATCG", seq_type: "DNA" },
			ctx,
		);
		expect(ctx.python.call).toHaveBeenCalledWith("biopython.sequence_stats", {
			sequence: "ATCGATCG",
			seq_type: "DNA",
		});
	});
});

describe("search_uniprot", () => {
	test("returns protein results with interpretation", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						results: [
							{
								primaryAccession: "P04637",
								proteinDescription: {
									recommendedName: {
										fullName: { value: "Cellular tumor antigen p53" },
									},
								},
								genes: [{ geneName: { value: "TP53" } }],
								organism: { scientificName: "Homo sapiens" },
								sequence: { length: 393, value: "MEEPQSDPSVEPPLSQETFSDLWKLLP" },
							},
						],
					}),
					{ status: 200 },
				),
			),
		) as any;

		const ctx = createMockContext();
		const result = await searchUniprot.execute({ query: "TP53" }, ctx);
		expect(result.success).toBe(true);
		expect(result.data?.n_results).toBe(1);
		expect(result.data?.results[0].gene).toBe("TP53");
		expect(result.data?.interpretation).toBeDefined();
		expect(result.data?.model_used).toBe(true);
	});

	test("returns error on API failure", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("Server Error", { status: 500 })),
		) as any;

		const ctx = createMockContext();
		const result = await searchUniprot.execute({ query: "TP53" }, ctx);
		expect(result.success).toBe(false);
		expect(result.error).toContain("500");
	});
});

describe("search_pdb", () => {
	test("returns structure results with interpretation for search", async () => {
		globalThis.fetch = mock((url: string) => {
			if (typeof url === "string" && url.includes("rcsbsearch")) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							result_set: [{ identifier: "4HHB", score: 1.0 }],
						}),
						{ status: 200 },
					),
				);
			}
			// Detail fetch
			return Promise.resolve(
				new Response(
					JSON.stringify({
						struct: { title: "Deoxy human hemoglobin" },
						exptl: [{ method: "X-RAY DIFFRACTION" }],
						rcsb_entry_info: { resolution_combined: [1.74] },
						rcsb_accession_info: { initial_release_date: "1984-07-17" },
					}),
					{ status: 200 },
				),
			);
		}) as any;

		const ctx = createMockContext();
		const result = await searchPdb.execute({ query: "hemoglobin" }, ctx);
		expect(result.success).toBe(true);
		expect(result.data?.results[0].pdb_id).toBe("4HHB");
		expect(result.data?.interpretation).toBeDefined();
		expect(result.data?.model_used).toBe(true);
	});

	test("returns error on PDB search failure", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("error", { status: 503 })),
		) as any;

		const ctx = createMockContext();
		const result = await searchPdb.execute({ query: "hemoglobin" }, ctx);
		expect(result.success).toBe(false);
		expect(result.error).toContain("503");
	});
});

describe("predict_structure", () => {
	test("returns AlphaFold prediction with interpretation", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify([
						{
							entryId: "AF-P69905-F1",
							gene: "HBA1",
							organismScientificName: "Homo sapiens",
							pdbUrl:
								"https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v4.pdb",
							cifUrl:
								"https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v4.cif",
							paeImageUrl:
								"https://alphafold.ebi.ac.uk/files/AF-P69905-F1-predicted_aligned_error_v4.png",
							confidenceUrl:
								"https://alphafold.ebi.ac.uk/files/AF-P69905-F1-confidence_v4.json",
							latestVersion: 4,
							uniprotStart: 1,
							uniprotEnd: 142,
							globalMetricValue: 92.5,
						},
					]),
					{ status: 200 },
				),
			),
		) as any;

		const ctx = createMockContext();
		const result = await predictStructure.execute(
			{ uniprot_id: "P69905" },
			ctx,
		);
		expect(result.success).toBe(true);
		expect(result.data?.gene).toBe("HBA1");
		expect(result.data?.mean_plddt).toBe(92.5);
		expect(result.data?.sequence_length).toBe(142);
		expect(result.data?.interpretation).toBeDefined();
		expect(result.data?.model_used).toBe(true);
	});

	test("returns error when UniProt ID not found", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("Not Found", { status: 404 })),
		) as any;

		const ctx = createMockContext();
		const result = await predictStructure.execute(
			{ uniprot_id: "XXXXXX" },
			ctx,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("No AlphaFold prediction");
	});
});
