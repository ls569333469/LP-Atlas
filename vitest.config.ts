import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
	},
	resolve: {
		alias: {
			"@lp-atlas/shared": path.resolve(__dirname, "src/shared/index.ts"),
		},
	},
});
