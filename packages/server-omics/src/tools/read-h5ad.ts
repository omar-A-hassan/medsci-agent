import { z } from "zod";
import { defineTool } from "@medsci/core";

export const readH5ad = defineTool({
  name: "read_h5ad",
  description:
    "Read an H5AD (AnnData) file and return metadata: number of observations, variables, column names. Use this as the first step to understand a single-cell or omics dataset.",
  schema: z.object({
    path: z.string().min(1).describe("Absolute path to the .h5ad file"),
  }),
  execute: async (input, ctx) => {
    const data = await ctx.python.call<{
      n_obs: number;
      n_vars: number;
      obs_columns: string[];
      var_columns: string[];
    }>("scanpy.read_h5ad", { path: input.path });
    return { success: true, data };
  },
});
