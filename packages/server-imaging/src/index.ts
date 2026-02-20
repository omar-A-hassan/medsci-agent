import { createMcpServer } from "@medsci/core";
import { analyzeMedicalImage } from "./tools";

await createMcpServer({
  name: "medsci-imaging",
  version: "0.1.0",
  tools: [analyzeMedicalImage],
});
