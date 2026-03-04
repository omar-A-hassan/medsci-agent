import { createMcpServer } from "@medsci/core";
import { acquireDocuments, resolveIdentifierToSources } from "./tools";

await createMcpServer({
  name: "medsci-acquisition",
  version: "0.1.0",
  tools: [resolveIdentifierToSources, acquireDocuments],
});
