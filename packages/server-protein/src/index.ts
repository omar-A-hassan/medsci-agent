import { createMcpServer } from "@medsci/core";
import {
  parseFasta,
  sequenceAnalysis,
  searchUniprot,
  searchPdb,
  predictStructure,
} from "./tools";

await createMcpServer({
  name: "medsci-protein",
  version: "0.1.0",
  tools: [parseFasta, sequenceAnalysis, searchUniprot, searchPdb, predictStructure],
});
