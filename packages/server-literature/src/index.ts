import { createMcpServer } from "@medsci/core";
import {
  searchPubmed,
  fetchAbstract,
  searchOpenAlex,
  searchClinicalTrials,
} from "./tools";

await createMcpServer({
  name: "medsci-literature",
  version: "0.1.0",
  tools: [searchPubmed, fetchAbstract, searchOpenAlex, searchClinicalTrials],
});
