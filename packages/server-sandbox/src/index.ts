import { createMcpServer } from "@medsci/core";
import {
	sandboxFetchArtifact,
	sandboxPrepare,
	sandboxRunJob,
	sandboxStatus,
	sandboxTeardown,
} from "./tools";

await createMcpServer({
	name: "medsci-sandbox",
	version: "0.1.0",
	tools: [
		sandboxPrepare,
		sandboxRunJob,
		sandboxStatus,
		sandboxFetchArtifact,
		sandboxTeardown,
	],
});
