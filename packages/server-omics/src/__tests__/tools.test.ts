import { test, expect, describe, mock, afterEach } from "bun:test";
import { createMockContext } from "@medsci/core";
import { differentialExpression } from "../tools/differential-expression";
import { geneSetEnrichment } from "../tools/gene-set-enrichment";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("differential_expression", () => {
  test("returns DE results with interpretation", async () => {
    const deData = {
      groups: ["cluster0", "cluster1"],
      top_genes: {
        cluster0: [{ gene: "CD8A", logfoldchange: 2.5, pval_adj: 0.001 }],
        cluster1: [{ gene: "MS4A1", logfoldchange: 1.8, pval_adj: 0.01 }],
      },
    };
    const ctx = createMockContext({ pythonResponse: deData });
    const result = await differentialExpression.execute(
      { path: "test.h5ad", groupby: "leiden" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data?.groups).toEqual(["cluster0", "cluster1"]);
    expect(result.data?.interpretation).toBeDefined();
    expect(result.data?.model_used).toBe(true);
  });

  test("calls python sidecar with correct args", async () => {
    const ctx = createMockContext({ pythonResponse: { groups: [], top_genes: {} } });
    await differentialExpression.execute(
      { path: "data.h5ad", groupby: "condition", method: "t-test", n_genes: 25 },
      ctx,
    );
    expect(ctx.python.call).toHaveBeenCalledWith("scanpy.differential_expression", {
      path: "data.h5ad",
      groupby: "condition",
      method: "t-test",
      n_genes: 25,
    });
  });

  test("still succeeds when MedGemma fails", async () => {
    const ctx = createMockContext({ pythonResponse: { groups: ["a"], top_genes: {} } });
    (ctx.ollama.generate as any).mockImplementation(() => {
      throw new Error("Ollama down");
    });
    const result = await differentialExpression.execute(
      { path: "test.h5ad", groupby: "leiden" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data?.model_used).toBe(false);
    expect(result.data?.interpretation).toBe("");
  });
});

describe("gene_set_enrichment", () => {
  test("returns enrichment results with interpretation", async () => {
    globalThis.fetch = mock((url: string) => {
      if (typeof url === "string" && url.includes("addList")) {
        return Promise.resolve(
          new Response(JSON.stringify({ userListId: 123 }), { status: 200 }),
        );
      }
      if (typeof url === "string" && url.includes("enrich")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              GO_Biological_Process_2023: [
                [0, "immune response (GO:0006955)", 0.001, 0, 0, ["CD8A", "CD3E"], 0.005],
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    }) as any;

    const ctx = createMockContext();
    const result = await geneSetEnrichment.execute(
      { genes: ["CD8A", "CD3E", "GZMA"] },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data?.n_enriched_terms).toBeGreaterThanOrEqual(1);
    expect(result.data?.interpretation).toBeDefined();
    expect(result.data?.model_used).toBe(true);
  });

  test("returns error when Enrichr submit fails", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("error", { status: 500 })),
    ) as any;

    const ctx = createMockContext();
    const result = await geneSetEnrichment.execute(
      { genes: ["TP53"] },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Enrichr");
  });
});
