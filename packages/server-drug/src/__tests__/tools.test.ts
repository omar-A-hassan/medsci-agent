import { test, expect, describe, mock, afterEach } from "bun:test";
import { createMockContext } from "@medsci/core";
import { analyzeMolecule } from "../tools/analyze-molecule";
import { lipinskiFilter } from "../tools/lipinski-filter";
import { similaritySearch } from "../tools/similarity-search";
import { predictAdmet, parseBinaryPrediction, TXGEMMA_MODEL } from "../tools/predict-admet";
import { searchChembl } from "../tools/search-chembl";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Shared RDKit response for predict_admet tests
const VALID_PROPS = {
  valid: true, molecular_weight: 300, logp: 2.5, tpsa: 80, hbd: 2, hba: 5, rotatable_bonds: 4,
};

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

describe("parseBinaryPrediction", () => {
  test("parses (B) as positive", () => {
    expect(parseBinaryPrediction("(B)", "B")).toBe(true);
  });

  test("parses (A) as negative", () => {
    expect(parseBinaryPrediction("(A)", "B")).toBe(false);
  });

  test("parses bare letter B as positive", () => {
    expect(parseBinaryPrediction("B", "B")).toBe(true);
  });

  test("handles lowercase", () => {
    expect(parseBinaryPrediction("(b)", "B")).toBe(true);
    expect(parseBinaryPrediction("a", "B")).toBe(false);
  });

  test("handles surrounding whitespace", () => {
    expect(parseBinaryPrediction("  (B)  \n", "B")).toBe(true);
  });

  test("handles letter with trailing text", () => {
    expect(parseBinaryPrediction("B crosses the BBB", "B")).toBe(true);
    expect(parseBinaryPrediction("A does not", "B")).toBe(false);
  });

  test("returns null for empty string", () => {
    expect(parseBinaryPrediction("", "B")).toBe(null);
    expect(parseBinaryPrediction("   ", "B")).toBe(null);
  });

  test("returns null for unparseable output", () => {
    expect(parseBinaryPrediction("I think yes", "B")).toBe(null);
    expect(parseBinaryPrediction("maybe", "B")).toBe(null);
  });
});

describe("predict_admet", () => {
  test("returns TxGemma predictions with interpretation", async () => {
    const ctx = createMockContext({ pythonResponse: VALID_PROPS });
    (ctx.ollama.generate as any).mockImplementation((_prompt: string, opts: any) => {
      if (opts?.model === TXGEMMA_MODEL) return Promise.resolve("(B)");
      return Promise.resolve("Mock ADMET interpretation.");
    });

    const result = await predictAdmet.execute({ smiles: "CCO" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data?.model_used).toBe(true);
    expect(result.data?.admet.bbb_penetration).toBe("yes");
    expect(result.data?.admet.herg_inhibition).toBe("blocker");
    expect(result.data?.admet.ames_mutagenicity).toBe("mutagenic");
    expect(result.data?.admet.dili_risk).toBe("yes");
    expect(result.data?.interpretation).toBeDefined();
    expect(result.data?.physicochemical.molecular_weight).toBe(300);
  });

  test("falls back to rule-based ADMET when TxGemma is unavailable", async () => {
    const ctx = createMockContext({ pythonResponse: VALID_PROPS });
    (ctx.ollama.generate as any).mockImplementation((_prompt: string, opts: any) => {
      if (opts?.model === TXGEMMA_MODEL) throw new Error("model not found");
      return Promise.resolve("Fallback interpretation.");
    });

    const result = await predictAdmet.execute({ smiles: "CCO" }, ctx);
    expect(result.success).toBe(true);
    // TxGemma failed but MedGemma interpretation worked
    expect(result.data?.model_used).toBe(true);
    // Rule-based fallback: TPSA=80 < 140 → "likely" absorbed
    expect(result.data?.admet.intestinal_absorption).toBe("likely");
    expect(result.data?.admet.note).toContain("Rule-based fallback");
    expect(ctx.log.warn).toHaveBeenCalled();
  });

  test("returns error for invalid SMILES", async () => {
    const ctx = createMockContext({ pythonResponse: { valid: false, error: "Invalid SMILES" } });
    const result = await predictAdmet.execute({ smiles: "INVALID" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid SMILES");
  });

  test("passes TXGEMMA_MODEL in generate opts", async () => {
    const ctx = createMockContext({ pythonResponse: VALID_PROPS });
    const calledModels: string[] = [];
    (ctx.ollama.generate as any).mockImplementation((_prompt: string, opts: any) => {
      if (opts?.model) calledModels.push(opts.model);
      return Promise.resolve("(A)");
    });

    await predictAdmet.execute({ smiles: "CCO" }, ctx);
    // Should have called TxGemma for each of the 6 ADMET endpoints
    const txgemmaCalls = calledModels.filter((m) => m === TXGEMMA_MODEL);
    expect(txgemmaCalls.length).toBe(6);
  });

  test("handles partial TxGemma failure gracefully", async () => {
    const ctx = createMockContext({ pythonResponse: VALID_PROPS });
    let callCount = 0;
    (ctx.ollama.generate as any).mockImplementation((_prompt: string, opts: any) => {
      if (opts?.model === TXGEMMA_MODEL) {
        callCount++;
        // First 3 calls succeed, last 3 throw
        if (callCount <= 3) return Promise.resolve("(A)");
        throw new Error("timeout");
      }
      return Promise.resolve("Partial interpretation.");
    });

    const result = await predictAdmet.execute({ smiles: "CCO" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data?.model_used).toBe(true);
    // Some predictions should be present, some "unknown"
    const admetValues = Object.values(result.data?.admet ?? {});
    expect(admetValues).toContain("unknown");
    // At least some predictions succeeded
    const knownValues = admetValues.filter((v) => v !== "unknown");
    expect(knownValues.length).toBeGreaterThan(0);
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
