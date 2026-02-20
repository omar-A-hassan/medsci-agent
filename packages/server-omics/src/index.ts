import { createMcpServer } from "@medsci/core";
import {
  readH5ad,
  preprocess,
  cluster,
  differentialExpression,
  geneSetEnrichment,
} from "./tools";

await createMcpServer({
  name: "medsci-omics",
  version: "0.1.0",
  tools: [readH5ad, preprocess, cluster, differentialExpression, geneSetEnrichment],
});
