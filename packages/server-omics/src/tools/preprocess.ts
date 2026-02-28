import { defineTool } from "@medsci/core";
import { z } from "zod";

export const preprocess = defineTool({
	name: "preprocess_omics",
	description:
		"Preprocess a single-cell RNA-seq dataset: filter cells/genes, normalize, log-transform, and identify highly variable genes. Returns QC summary.",
	schema: z.object({
		path: z.string().min(1).describe("Path to the input .h5ad file"),
		output_path: z
			.string()
			.min(1)
			.describe("Path to save the preprocessed .h5ad file"),
		min_genes: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Minimum genes per cell (default: 200)"),
		min_cells: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Minimum cells per gene (default: 3)"),
		n_top_genes: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Number of highly variable genes (default: 2000)"),
	}),
	execute: async (input, ctx) => {
		const data = await ctx.python.call<{
			n_obs_after: number;
			n_vars_after: number;
			n_highly_variable: number;
			output_path: string;
		}>("scanpy.preprocess", {
			path: input.path,
			output_path: input.output_path,
			min_genes: input.min_genes ?? 200,
			min_cells: input.min_cells ?? 3,
			n_top_genes: input.n_top_genes ?? 2000,
		});
		return { success: true, data };
	},
});
