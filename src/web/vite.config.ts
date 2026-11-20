import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: dir,
	plugins: [react()],
	resolve: {
		alias: {
			"@lp-atlas/shared": path.resolve(dir, "../shared/index.ts"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5173,
		strictPort: true,
		proxy: {
			"/api": {
				target: "http://127.0.0.1:3001",
				changeOrigin: true,
			},
		},
	},
	build: {
		outDir: path.resolve(dir, "../../dist/web"),
		emptyOutDir: true,
	},
});
