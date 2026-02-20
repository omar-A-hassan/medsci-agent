import { z } from "zod";
import { defineTool } from "@medsci/core";

export const similaritySearch = defineTool({
  name: "molecular_similarity",
  description:
    "Compute Tanimoto similarity between two molecules using Morgan fingerprints (ECFP4). Score ranges 0-1, where >0.7 suggests similar bioactivity.",
  schema: z.object({
    smiles1: z.string().min(1).describe("SMILES string of the first molecule"),
    smiles2: z.string().min(1).describe("SMILES string of the second molecule"),
  }),
  execute: async (input, ctx) => {
    const data = await ctx.python.call<{
      tanimoto?: number;
      error?: string;
    }>("rdkit.similarity", {
      smiles1: input.smiles1,
      smiles2: input.smiles2,
    });

    if (data.error) {
      return { success: false, error: data.error };
    }
    return { success: true, data };
  },
});
