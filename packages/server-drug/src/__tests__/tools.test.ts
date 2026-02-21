import { test, expect, describe, mock, afterEach } from "bun:test";
import { createMockContext } from "@medsci/core";
import { analyzeMolecule } from "../tools/analyze-molecule";
import { lipinskiFilter } from "../tools/lipinski-filter";
import { similaritySearch } from "../tools/similarity-search";
import { predictAdmet } from "../tools/predict-admet";
import { searchChembl } from "../tools/search-chembl";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("analyze_molecule", () => {
  test("returns properties for valid SMILES", async () => {
    const ctx = createMockContext({
      pythonResponse: {
        valid: true,
        canonical_smiles: "CC(=O)OC1=CC=CC=C1C(=O)O",
        molecular_weight: 180.16,
        logp: 1.31,
        hbd: 1,
        hba: 4,
        tpsa: 63.6,
        rotatable_bonds: 3,
        num_atoms: 13,
        num_rings: 1,
        formula: "C9H8O4",
      },
    });
    const result = await analyzeMolecule.execute({ smiles: "CC(=O)OC1=CC=CC=C1C(=O)O" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data?.molecular_weight).toBe(180.16);
    expect(result.data?.formula).toBe("C9H8O4");
  });

  test("returns error for invalid SMILES", async () => {
    const ctx = createMockContext({ pythonResponse: { valid: false, error: "Invalid SMILES string" } });
    const result = await analyzeMolecule.execute({ smiles: "not_a_molecule" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid SMILES");
  });

  test("rejects empty SMILES", async () => {
    const ctx = createMockContext();
    const result = await analyzeMolecule.execute({ smiles: "" } as any, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid input");
  });

  test("calls python sidecar with correct method", async () => {
    const ctx = createMockContext({ pythonResponse: { valid: true, canonical_smiles: "C" } });
    await analyzeMolecule.execute({ smiles: "C" }, ctx);
    expect(ctx.python.call).toHaveBeenCalledWith("rdkit.mol_from_smiles", { smiles: "C" });
  });
});

describe("lipinski_filter", () => {
  test("passes drug-like molecule", async () => {
    const ctx = createMockContext({
      pythonResponse: { valid: true, passes: true, violations: 0, mw: 300, logp: 2.5, hbd: 2, hba: 5 },
    });
    const result = await lipinskiFilter.execute({ smiles: "CCO" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data?.passes).toBe(true);
    expect(result.data?.violations).toBe(0);
  });

  test("fails non-drug-like molecule", async () => {
    const ctx = createMockContext({
      pythonResponse: { valid: true, passes: false, violations: 3, mw: 800, logp: 7, hbd: 8, hba: 12 },
    });
    const result = await lipinskiFilter.execute({ smiles: "LARGE_MOLECULE" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data?.passes).toBe(false);
    expect(result.data?.violations).toBe(3);
  });
});

describe("molecular_similarity", () => {
  test("returns Tanimoto score", async () => {
    const ctx = createMockContext({ pythonResponse: { tanimoto: 0.78 } });
    const result = await similaritySearch.execute(
      { smiles1: "CCO", smiles2: "CCCO" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data?.tanimoto).toBe(0.78);
  });

  test("handles invalid molecule in pair", async () => {
    const ctx = createMockContext({ pythonResponse: { error: "One or both SMILES are invalid" } });
    const result = await similaritySearch.execute(
      { smiles1: "CCO", smiles2: "INVALID" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid");
  });
});

describe("predict_admet", () => {
  test("returns ADMET predictions with model_used=true", async () => {
    const ctx = createMockContext({
      pythonResponse: { valid: true, molecular_weight: 300, logp: 2.5, tpsa: 80, hbd: 2, hba: 5, rotatable_bonds: 4 },
      generateJsonResponse: {
        absorption: "high",
        bbb_penetration: "yes",
        cyp_inhibition: ["CYP3A4"],
        herg_risk: "low",
        hepatotoxicity_risk: "low",
        overall_druglikeness: 0.85,
      },
    });
    const result = await predictAdmet.execute({ smiles: "CCO" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data?.admet.absorption).toBe("high");
    expect(result.data?.model_used).toBe(true);
    expect(result.data?.physicochemical.molecular_weight).toBe(300);
  });

  test("falls back to rule-based ADMET when MedGemma fails", async () => {
    const ctx = createMockContext({
      pythonResponse: { valid: true, molecular_weight: 300, logp: 2.5, tpsa: 80, hbd: 2, hba: 5, rotatable_bonds: 4 },
    });
    (ctx.ollama.generateJson as any).mockImplementation(() => {
      throw new Error("Ollama down");
    });
    const result = await predictAdmet.execute({ smiles: "CCO" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data?.model_used).toBe(false);
    // Rule-based fallback: TPSA=80 < 140 → absorption "high"
    expect(result.data?.admet.absorption).toBe("high");
    expect(result.data?.admet.note).toContain("Rule-based fallback");
  });

  test("returns error for invalid SMILES", async () => {
    const ctx = createMockContext({ pythonResponse: { valid: false, error: "Invalid SMILES" } });
    const result = await predictAdmet.execute({ smiles: "INVALID" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid SMILES");
  });
});

describe("search_chembl", () => {
  test("searches targets and returns interpretation", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            targets: [
              { target_chembl_id: "CHEMBL220", pref_name: "EGFR", organism: "Homo sapiens", target_type: "SINGLE PROTEIN" },
            ],
          }),
          { status: 200 },
        ),
      ),
    ) as any;

    const ctx = createMockContext();
    const result = await searchChembl.execute({ query: "EGFR", search_type: "target" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data?.search_type).toBe("target");
    expect(result.data?.results[0].chembl_id).toBe("CHEMBL220");
    expect(result.data?.interpretation).toBeDefined();
    expect(result.data?.model_used).toBe(true);
  });

  test("searches molecules and returns results", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            molecules: [
              {
                molecule_chembl_id: "CHEMBL25",
                pref_name: "ASPIRIN",
                max_phase: 4,
                molecule_type: "Small molecule",
                molecule_structures: { canonical_smiles: "CC(=O)OC1=CC=CC=C1C(=O)O" },
                molecule_properties: { full_mwt: "180.16" },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    ) as any;

    const ctx = createMockContext();
    const result = await searchChembl.execute({ query: "aspirin" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data?.results[0].name).toBe("ASPIRIN");
    expect(result.data?.results[0].smiles).toBe("CC(=O)OC1=CC=CC=C1C(=O)O");
  });

  test("returns error on API failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" })),
    ) as any;

    const ctx = createMockContext();
    const result = await searchChembl.execute({ query: "test" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("503");
  });
});
