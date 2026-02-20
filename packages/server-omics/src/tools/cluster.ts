import { z } from "zod";
import { defineTool } from "@medsci/core";

export const cluster = defineTool({
  name: "cluster_cells",
  description:
    "Cluster cells in a preprocessed single-cell dataset using Leiden or Louvain community detection. Returns cluster assignments and UMAP coordinates.",
  schema: z.object({
    path: z.string().min(1).describe("Path to the preprocessed .h5ad file"),
    resolution: z.number().positive().optional().describe("Clustering resolution (default: 1.0, higher = more clusters)"),
    method: z.enum(["leiden", "louvain"]).optional().describe("Clustering algorithm (default: leiden)"),
  }),
  execute: async (input, ctx) => {
    const data = await ctx.python.call<{
      method: string;
      n_clusters: number;
      cluster_sizes: Record<string, number>;
    }>("scanpy.cluster", {
      path: input.path,
      resolution: input.resolution ?? 1.0,
      method: input.method ?? "leiden",
    });
    return { success: true, data };
  },
});
