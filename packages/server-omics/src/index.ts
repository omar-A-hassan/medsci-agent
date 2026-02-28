import { createMcpServer } from "@medsci/core";
import {
	cluster,
	differentialExpression,
	geneSetEnrichment,
	preprocess,
	readH5ad,
} from "./tools";

await createMcpServer({
	name: "medsci-omics",
	version: "0.1.0",
	tools: [
		readH5ad,
		preprocess,
		cluster,
		differentialExpression,
		geneSetEnrichment,
	],
});
