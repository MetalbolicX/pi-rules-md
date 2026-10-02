export default [
	{
		input: "index.ts",
		platform: "node",
		output: {
			file: "dist/extension.js",
			format: "esm",
			minify: false,
		},
		// typebox is host-provided by Pi (peerDependency): never bundle it into the
		// extension, or a physical copy bypasses Pi's module mapping and duplicates runtime modules.
		external: [/^node:/, /^typebox$/],
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
