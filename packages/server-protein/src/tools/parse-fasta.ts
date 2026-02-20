import { z } from "zod";
import { defineTool } from "@medsci/core";

export const parseFasta = defineTool({
  name: "parse_fasta",
  description:
    "Parse a FASTA file and return sequence metadata: IDs, names, descriptions, lengths, and sequence previews.",
  schema: z.object({
    path: z.string().min(1).describe("Path to the FASTA file"),
    max_records: z.number().int().positive().optional().describe("Maximum records to parse (default: 100)"),
  }),
  execute: async (input, ctx) => {
    const data = await ctx.python.call<{
      n_records: number;
      records: Array<{
        id: string;
        name: string;
        description: string;
        length: number;
        sequence_preview: string;
      }>;
    }>("biopython.parse_fasta", {
      path: input.path,
      max_records: input.max_records ?? 100,
    });
    return { success: true, data };
  },
});
