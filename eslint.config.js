import js from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";

export default tseslint.config(
	{
		ignores: ["dist/**", "coverage/**", "examples/backend/**"],
	},
	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	...pluginVue.configs["flat/recommended"],
	{
		languageOptions: {
			globals: {
				...globals.node,
				...globals.browser,
			},
		},
	},
	{
		files: ["**/*.ts", "**/*.vue"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".vue"],
			},
		},
	},
	{
		files: ["**/*.vue"],
		languageOptions: {
			parserOptions: {
				parser: tseslint.parser,
			},
		},
	},
	{
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_" },
			],
		},
	},
	{
		// Config files sit outside tsconfig.json's `include`, so they get no type
		// information from the project service — lint them without type-aware rules.
		files: ["*.config.ts", "*.config.js"],
		extends: [tseslint.configs.disableTypeChecked],
	},
	{
		// Test files build event/mock fixtures with intentionally loose typing
		// (partial protocol events, mock handlers matching an async interface without
		// needing to await anything), and mount several throwaway components per file
		// to exercise the plugin — relax the rules that exist to catch that in
		// production code.
		files: ["src/__tests__/**/*.ts"],
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-return": "off",
			"@typescript-eslint/require-await": "off",
			"vue/one-component-per-file": "off",
		},
	},
	eslintPluginPrettierRecommended,
);
