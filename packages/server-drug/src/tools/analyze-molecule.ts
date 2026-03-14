import { defineTool, interpretWithMedGemma, withOptionalSynthesis } from "@medsci/core";
import { z } from "zod";

export const analyzeMolecule = defineTool({
	name: "analyze_molecule",
	description:
		"Analyze a molecule from its SMILES string. Returns physicochemical properties: molecular weight, LogP, H-bond donors/acceptors, TPSA, rotatable bonds, ring count, and molecular formula.",
	schema: z.object({
		smiles: z.string().min(1).describe("SMILES string of the molecule"),
		synthesize: z.boolean().optional().describe("Set to false to skip MedGemma synthesis and return raw data"),
	}),
	execute: async (input, ctx) => {
		const data = await ctx.python.call<{
			valid: boolean;
			error?: string;
			canonical_smiles?: string;
			molecular_weight?: number;
			logp?: number;
			hbd?: number;
			hba?: number;
			tpsa?: number;
			rotatable_bonds?: number;
			num_atoms?: number;
			num_rings?: number;
			formula?: string;
		}>("rdkit.mol_from_smiles", { smiles: input.smiles });

		if (!data.valid) {
			return { success: false, error: data.error ?? "Invalid SMILES" };
		}

		return {
			success: true,
			data: await withOptionalSynthesis(input.synthesize ?? true, data, () =>
				interpretWithMedGemma(
					ctx,
					data,
					"Assess this molecule's drug-likeness based on its physicochemical properties. " +
						"Comment on oral bioavailability, membrane permeability, and any red flags.",
				),
			),
		};
	},
});
