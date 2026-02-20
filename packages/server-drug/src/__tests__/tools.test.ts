import { test, expect, describe, mock, beforeEach } from "bun:test";
import type { ToolContext } from "@medsci/core";
import { analyzeMolecule } from "../tools/analyze-molecule";
import { lipinskiFilter } from "../tools/lipinski-filter";
import { similaritySearch } from "../tools/similarity-search";

function createMockContext(pythonResponse?: unknown): ToolContext {
  return {
    ollama: {
      generate: mock(() => Promise.resolve("mock")),
      generateJson: mock(() => Promise.resolve({})),
      embed: mock(() => Promise.resolve([])),
      classify: mock(() =>
        Promise.resolve({ label: "ok", score: 0.9, allScores: {} }),
      ),
      isAvailable: mock(() => Promise.resolve(true)),
    },
    python: {
      call: mock(() => Promise.resolve(pythonResponse ?? {})),
      isRunning: () => true,
      start: mock(() => Promise.resolve()),
      stop: mock(() => Promise.resolve()),
    },
    log: {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    },
  };
}

describe("analyze_molecule", () => {
  test("returns properties for valid SMILES", async () => {
    const ctx = createMockContext({
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
    });
    const result = await analyzeMolecule.execute({ smiles: "CC(=O)OC1=CC=CC=C1C(=O)O" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data?.molecular_weight).toBe(180.16);
    expect(result.data?.formula).toBe("C9H8O4");
  });

  test("returns error for invalid SMILES", async () => {
    const ctx = createMockContext({ valid: false, error: "Invalid SMILES string" });
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
    const ctx = createMockContext({ valid: true, canonical_smiles: "C" });
    await analyzeMolecule.execute({ smiles: "C" }, ctx);
    expect(ctx.python.call).toHaveBeenCalledWith("rdkit.mol_from_smiles", { smiles: "C" });
  });
});

describe("lipinski_filter", () => {
  test("passes drug-like molecule", async () => {
    const ctx = createMockContext({
      valid: true,
      passes: true,
      violations: 0,
      mw: 300,
      logp: 2.5,
      hbd: 2,
      hba: 5,
    });
    const result = await lipinskiFilter.execute({ smiles: "CCO" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data?.passes).toBe(true);
    expect(result.data?.violations).toBe(0);
  });

  test("fails non-drug-like molecule", async () => {
    const ctx = createMockContext({
      valid: true,
      passes: false,
      violations: 3,
      mw: 800,
      logp: 7,
      hbd: 8,
      hba: 12,
    });
    const result = await lipinskiFilter.execute({ smiles: "LARGE_MOLECULE" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data?.passes).toBe(false);
    expect(result.data?.violations).toBe(3);
  });
});

describe("molecular_similarity", () => {
  test("returns Tanimoto score", async () => {
    const ctx = createMockContext({ tanimoto: 0.78 });
    const result = await similaritySearch.execute(
      { smiles1: "CCO", smiles2: "CCCO" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data?.tanimoto).toBe(0.78);
  });

  test("handles invalid molecule in pair", async () => {
    const ctx = createMockContext({ error: "One or both SMILES are invalid" });
    const result = await similaritySearch.execute(
      { smiles1: "CCO", smiles2: "INVALID" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid");
  });
});
