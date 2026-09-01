import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
	build: {
		lib: {
			entry: path.resolve(import.meta.dirname, "src/index.ts"),
			name: "AgUiVue",
			formats: ["es", "cjs"],
			fileName: "index",
		},
		rollupOptions: {
			external: ["vue", "@ag-ui/client"],
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(import.meta.dirname, "src"),
		},
	},
});
