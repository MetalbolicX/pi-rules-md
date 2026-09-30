export default [
	{
		input: "index.ts",
		platform: "node",
		output: {
			file: "dist/extension.js",
			format: "esm",
			minify: false,
		},
		external: [/^node:/],
	},
	{
		input: "src/cli/main.ts",
		platform: "node",
		output: {
			file: "dist/cli.mjs",
			format: "esm",
			minify: false,
			banner: "#!/usr/bin/env node",
		},
		external: [/^node:/],
	},
];
