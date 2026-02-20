import { z } from "zod";
import { defineTool, interpretWithMedGemma } from "@medsci/core";

export const differentialExpression = defineTool({
  name: "differential_expression",
  description:
    "Run differential expression analysis between cell groups. Identifies genes that are significantly up- or down-regulated between clusters or conditions.",
  schema: z.object({
    path: z.string().min(1).describe("Path to the clustered .h5ad file"),
    groupby: z.string().min(1).describe("Column in obs to group by (e.g. 'leiden', 'condition')"),
    method: z.enum(["wilcoxon", "t-test", "logreg"]).optional().describe("Statistical test method (default: wilcoxon)"),
    n_genes: z.number().int().positive().optional().describe("Number of top genes per group (default: 50)"),
  }),
  execute: async (input, ctx) => {
    const data = await ctx.python.call<{
      groups: string[];
      top_genes: Record<string, Array<{
        gene: string;
        logfoldchange: number;
        pval_adj: number;
      }>>;
    }>("scanpy.differential_expression", {
      path: input.path,
      groupby: input.groupby,
      method: input.method ?? "wilcoxon",
      n_genes: input.n_genes ?? 50,
    });
    const { interpretation, model_used } = await interpretWithMedGemma(
      ctx,
      data.top_genes,
      `Interpret these differentially expressed genes grouped by "${input.groupby}". ` +
        "What biological processes, cell types, or pathways do the top markers suggest? " +
        "Flag any known disease associations.",
    );

    return { success: true, data: { ...data, interpretation, model_used } };
  },
});
