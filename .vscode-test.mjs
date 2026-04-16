import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	version: '1.114.0',
	download: {
		timeout: 120_000,
	},
});
