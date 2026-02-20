import { test, expect, describe, mock, afterEach } from "bun:test";
import type { ToolContext } from "@medsci/core";
import { sequenceAnalysis } from "../tools/sequence-analysis";
import { searchUniprot } from "../tools/search-uniprot";
import { searchPdb } from "../tools/search-pdb";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createMockContext(pythonResponse?: unknown): ToolContext {
  return {
    ollama: {
      generate: mock(() => Promise.resolve("Mock protein interpretation.")),
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

describe("analyze_sequence", () => {
  test("returns sequence stats with interpretation", async () => {
    const ctx = createMockContext({
      length: 150,
      composition: { A: 10, G: 20 },
      molecular_weight: 16500.5,
      seq_type: "protein",
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
    const ctx = createMockContext({ length: 10, composition: {}, seq_type: "DNA" });
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
                proteinDescription: { recommendedName: { fullName: { value: "Cellular tumor antigen p53" } } },
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
            JSON.stringify({ result_set: [{ identifier: "4HHB", score: 1.0 }] }),
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
