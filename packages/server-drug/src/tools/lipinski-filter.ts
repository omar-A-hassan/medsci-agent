import { defineTool } from "@medsci/core";
import { z } from "zod";

export const lipinskiFilter = defineTool({
	name: "lipinski_filter",
	description:
		"Check if a molecule passes Lipinski's Rule of Five for drug-likeness. Evaluates MW<500, LogP<5, HBD≤5, HBA≤10. Reports violations.",
	schema: z.object({
		smiles: z.string().min(1).describe("SMILES string of the molecule"),
	}),
	execute: async (input, ctx) => {
		const data = await ctx.python.call<{
			valid: boolean;
			error?: string;
			passes?: boolean;
			violations?: number;
			mw?: number;
			logp?: number;
			hbd?: number;
			hba?: number;
		}>("rdkit.lipinski_filter", { smiles: input.smiles });

		if (!data.valid) {
			return { success: false, error: data.error ?? "Invalid SMILES" };
		}
		return { success: true, data };
	},
});
