import { runDaemonCatalogProcess } from "../../src/modes/daemon/daemon-catalog-process.js";

void runDaemonCatalogProcess();
setImmediate(() => {
	throw Object.assign(new Error("catalog crash fixture"), {
		code: "ECATALOGTEST",
		stack: "Error: catalog crash fixture",
	});
});
