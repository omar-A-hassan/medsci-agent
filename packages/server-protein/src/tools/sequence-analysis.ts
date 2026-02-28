import { defineTool, interpretWithMedGemma } from "@medsci/core";
import { z } from "zod";

export const sequenceAnalysis = defineTool({
	name: "analyze_sequence",
	description:
		"Analyze a protein or DNA sequence: compute length, amino acid composition, molecular weight. For DNA, can also translate to protein.",
	schema: z.object({
		sequence: z
			.string()
			.min(1)
			.describe("The amino acid or nucleotide sequence"),
		seq_type: z
			.enum(["protein", "DNA", "RNA"])
			.optional()
			.describe("Sequence type (default: protein)"),
		translate: z
			.boolean()
			.optional()
			.describe("If DNA/RNA, translate to protein (default: false)"),
	}),
	execute: async (input, ctx) => {
		const seqType = input.seq_type ?? "protein";

		const stats = await ctx.python.call<{
			length: number;
			composition: Record<string, number>;
			molecular_weight?: number;
			seq_type: string;
		}>("biopython.sequence_stats", {
			sequence: input.sequence,
			seq_type: seqType,
		});

		let translation;
		if (input.translate && (seqType === "DNA" || seqType === "RNA")) {
			translation = await ctx.python.call<{
				dna_length: number;
				protein_length: number;
				protein_sequence: string;
			}>("biopython.translate", { sequence: input.sequence });
		}

		const seqData = { ...stats, translation };

		const { interpretation, model_used } = await interpretWithMedGemma(
			ctx,
			seqData,
			`Analyze this ${seqType} sequence (${stats.length} residues). ` +
				"What can the amino acid composition and molecular weight tell us about this protein's properties, " +
				"localization, or function?",
		);

		return {
			success: true,
			data: { ...seqData, interpretation, model_used },
		};
	},
});
