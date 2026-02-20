import { createMcpServer } from "@medsci/core";
import {
  analyzeMolecule,
  lipinskiFilter,
  similaritySearch,
  predictAdmet,
  searchChembl,
} from "./tools";

await createMcpServer({
  name: "medsci-drug",
  version: "0.1.0",
  tools: [analyzeMolecule, lipinskiFilter, similaritySearch, predictAdmet, searchChembl],
});
