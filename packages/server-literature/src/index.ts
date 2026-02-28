import { createMcpServer } from "@medsci/core";
import {
	fetchAbstract,
	searchClinicalTrials,
	searchOpenAlex,
	searchPubmed,
} from "./tools";

await createMcpServer({
	name: "medsci-literature",
	version: "0.1.0",
	tools: [searchPubmed, fetchAbstract, searchOpenAlex, searchClinicalTrials],
});
