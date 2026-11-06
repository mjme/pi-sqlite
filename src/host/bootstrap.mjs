// Entry point of pi-sqlite's query process (forked by src/client.ts).
//
// Plain JavaScript on purpose: Node refuses to strip TypeScript types from files under
// node_modules, which is where `pi install` may put this package. This hook strips them for this
// package's own .ts files (which use erasable syntax only), then loads the real host.
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

const srcRoot = new URL("../", import.meta.url).href;

registerHooks({
	load(url, context, nextLoad) {
		if (url.startsWith(srcRoot) && url.endsWith(".ts")) {
			const source = stripTypeScriptTypes(readFileSync(new URL(url), "utf8"));
			return { format: "module", source, shortCircuit: true };
		}
		return nextLoad(url, context);
	},
});

await import("./db-host.ts");
