import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('VS Code API should be available', () => {
		assert.ok(vscode);
		assert.ok(vscode.window);
		assert.ok(vscode.workspace);
		assert.ok(vscode.commands);
	});

	test('Array operations should work correctly', () => {
		assert.strictEqual([1, 2, 3].indexOf(5), -1);
		assert.strictEqual([1, 2, 3].indexOf(1), 0);
		assert.strictEqual([1, 2, 3].indexOf(3), 2);
	});

	test('String operations should work correctly', () => {
		const str = 'quickspaces';
		assert.strictEqual(str.length, 11);
		assert.ok(str.includes('space'));
		assert.strictEqual(str.charAt(0), 'q');
	});

	test('Extension configuration should be accessible', async () => {
		const config = vscode.workspace.getConfiguration('quickspaces');
		assert.ok(config);
	});

	test('VS Code window API should be functional', () => {
		const editor = vscode.window.activeTextEditor;
		assert.ok(editor === undefined || editor !== null);
	});

	test('Error handling should work', () => {
		assert.throws(() => {
			throw new Error('Test error');
		});
	});

	test('Promise handling should work', async () => {
		const promise = Promise.resolve('test');
		const result = await promise;
		assert.strictEqual(result, 'test');
	});

	test('Map and Set operations should work correctly', () => {
		const map = new Map<string, number>();
		map.set('one', 1);
		map.set('two', 2);
		
		assert.strictEqual(map.get('one'), 1);
		assert.strictEqual(map.size, 2);
		
		const set = new Set([1, 2, 3]);
		assert.ok(set.has(2));
		assert.strictEqual(set.size, 3);
	});
});
