import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// libsql native statements finalize on GC even after Client.close(). Test workers only.
		pool: "forks",
		poolOptions: { forks: { execArgv: ["--expose-gc"] } },
		include: ["test/**/*.test.ts"],
	},
	resolve: {
		alias: {
			"@lp-atlas/shared": path.resolve(__dirname, "src/shared/index.ts"),
		},
	},
});
