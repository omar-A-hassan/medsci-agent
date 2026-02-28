import { createMcpServer } from "@medsci/core";
import {
	parseFasta,
	predictStructure,
	searchPdb,
	searchUniprot,
	sequenceAnalysis,
} from "./tools";

await createMcpServer({
	name: "medsci-protein",
	version: "0.1.0",
	tools: [
		parseFasta,
		sequenceAnalysis,
		searchUniprot,
		searchPdb,
		predictStructure,
	],
});
