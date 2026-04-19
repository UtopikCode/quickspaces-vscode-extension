import * as assert from 'assert';
import * as http from 'http';
import * as vscode from 'vscode';
import {
    QuickspacesTreeProvider,
    ControlPlaneItem,
    WorkspaceItem,
    StatusItem,
    httpGetJson,
    httpPostJson,
    httpRequestJson,
    ControlPlane,
} from '../extension';

class FakeWorkspaceState implements vscode.Memento {
    private store = new Map<string, any>();

    get<T>(key: string, defaultValue?: T): T | undefined {
        if (this.store.has(key)) {
            return this.store.get(key);
        }
        return defaultValue;
    }

    update(key: string, value: any): Thenable<void> {
        this.store.set(key, value);
        return Promise.resolve();
    }

    keys(): readonly string[] {
        return [...this.store.keys()];
    }
}

suite('QuickspacesTreeProvider Tests', () => {
    const fakeContext = {
        workspaceState: new FakeWorkspaceState(),
        globalState: new FakeWorkspaceState(),
        subscriptions: [] as vscode.Disposable[],
        extension: { id: 'test.extension' },
    } as unknown as vscode.ExtensionContext;

    test('normalizeControlPlane handles ControlPlane and tree items', () => {
        const provider = new QuickspacesTreeProvider(fakeContext);

        const cp: ControlPlane = { name: 'Test', url: 'https://example.com' };
        assert.deepStrictEqual(provider['resolveControlPlane'](cp), cp);

        const cpItem = new ControlPlaneItem(cp);
        assert.deepStrictEqual(provider['resolveControlPlane'](cpItem), cp);

        const treeItem = new vscode.TreeItem('Tree Label');
        treeItem.description = 'https://example.com';
        assert.deepStrictEqual(provider['resolveControlPlane'](treeItem), {
            name: 'Tree Label',
            url: 'https://example.com',
        });

        const invalidItem = new vscode.TreeItem('No Description');
        assert.strictEqual(provider['resolveControlPlane'](invalidItem), undefined);
    });

    test('controlPlaneDescription returns correct labels', () => {
        const provider = new QuickspacesTreeProvider(fakeContext);
        provider['controlPlanes'] = [];
        assert.strictEqual(provider['controlPlaneDescription'](), '');

        provider['controlPlanes'] = [{ name: 'One', url: 'https://one.example' }];
        assert.strictEqual(provider['controlPlaneDescription'](), '1 control plane');

        provider['controlPlanes'] = [
            { name: 'One', url: 'https://one.example' },
            { name: 'Two', url: 'https://two.example' },
        ];
        assert.strictEqual(provider['controlPlaneDescription'](), '2 control planes');
    });

    test('resolveWorkspace returns workspace and control plane container', () => {
        const provider = new QuickspacesTreeProvider(fakeContext);
        const workspace = { workspace_id: 'ws-123', repo_owner: 'octo', repo_name: 'hello' };
        provider['controlPlanes'] = [{ name: 'Main', url: 'https://example.com' }];

        const workspaceItem = new WorkspaceItem(workspace, 'Main');
        const resolved = provider['resolveWorkspace'](workspaceItem);

        assert.ok(resolved);
        assert.deepStrictEqual(resolved?.workspace, workspace);
        assert.deepStrictEqual(resolved?.controlPlane, provider['controlPlanes'][0]);
    });

    test('ControlPlaneItem defaults to expanded state', () => {
        const cp: ControlPlane = { name: 'Test', url: 'https://example.com' };
        const cpItem = new ControlPlaneItem(cp);
        const treeItem = cpItem.getTreeItem();
        assert.strictEqual(treeItem.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    });

    test('getAccessToken requests GitHub scopes and returns the access token', async () => {
        const originalGetSession = (vscode.authentication as any).getSession;
        let receivedProviderId: string | undefined;
        let receivedScopes: readonly string[] | undefined;
        let receivedCreateIfNone: boolean | undefined;

        (vscode.authentication as any).getSession = async (providerId: string, scopes: readonly string[], options: { createIfNone: boolean }) => {
            receivedProviderId = providerId;
            receivedScopes = scopes;
            receivedCreateIfNone = options.createIfNone;
            return { accessToken: 'test-token' } as any;
        };

        const provider = new QuickspacesTreeProvider(fakeContext);
        const token = await provider['getAccessToken']({ name: 'Test', url: 'https://example.com' }, true);

        assert.strictEqual(token, 'test-token');
        assert.strictEqual(receivedProviderId, 'github');
        assert.deepStrictEqual(receivedScopes, ['repo']);
        assert.strictEqual(receivedCreateIfNone, true);

        (vscode.authentication as any).getSession = originalGetSession;
    });

    test('getAccessToken returns undefined when no session exists and createIfNone is false', async () => {
        const originalGetSession = (vscode.authentication as any).getSession;
        (vscode.authentication as any).getSession = async () => undefined;

        const provider = new QuickspacesTreeProvider(fakeContext);
        const token = await provider['getAccessToken']({ name: 'Test', url: 'https://example.com' }, false);

        assert.strictEqual(token, undefined);

        (vscode.authentication as any).getSession = originalGetSession;
    });
});

suite('HTTP helper tests', () => {
    test('httpGetJson parses valid JSON', async () => {
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ hello: 'world' }));
        });

        await new Promise<void>(resolve => server.listen(0, resolve));
        const port = (server.address() as any).port;
        const result = await httpGetJson<{ hello: string }>(`http://127.0.0.1:${port}/`);
        assert.deepStrictEqual(result, { hello: 'world' });
        server.close();
    });

    test('httpGetJson sends a default User-Agent header', async () => {
        const server = http.createServer((req, res) => {
            assert.strictEqual(req.headers['user-agent'], 'Quickspaces VS Code Extension');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });

        await new Promise<void>(resolve => server.listen(0, resolve));
        const port = (server.address() as any).port;
        await httpGetJson<{ ok: boolean }>(`http://127.0.0.1:${port}/`);
        server.close();
    });

    test('httpGetJson rejects on non-200 responses', async () => {
        const server = http.createServer((req, res) => {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        });

        await new Promise<void>(resolve => server.listen(0, resolve));
        const port = (server.address() as any).port;

        await assert.rejects(
            httpGetJson(`http://127.0.0.1:${port}/`),
            /HTTP 404:/,
        );

        server.close();
    });

    test('httpGetJson rejects on invalid JSON', async () => {
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('not-json');
        });

        await new Promise<void>(resolve => server.listen(0, resolve));
        const port = (server.address() as any).port;

        await assert.rejects(
            httpGetJson(`http://127.0.0.1:${port}/`),
            /Invalid JSON response/,
        );

        server.close();
    });

    test('httpPostJson sends form data and parses response', async () => {
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                assert.strictEqual(body, 'code=test-code');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ access_token: 'abc123', expires_in: 60 }));
            });
        });

        await new Promise<void>(resolve => server.listen(0, resolve));
        const port = (server.address() as any).port;

        const result = await httpPostJson<{ access_token: string; expires_in: number }>(
            `http://127.0.0.1:${port}/`,
            'code=test-code',
        );

        assert.deepStrictEqual(result, { access_token: 'abc123', expires_in: 60 });
        server.close();
    });

    test('httpRequestJson supports PATCH requests', async () => {
        const server = http.createServer((req, res) => {
            assert.strictEqual(req.method, 'PATCH');
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                assert.strictEqual(body, JSON.stringify({ ref: 'main' }));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            });
        });

        await new Promise<void>(resolve => server.listen(0, resolve));
        const port = (server.address() as any).port;

        const result = await httpRequestJson<{ ok: boolean }>(
            `http://127.0.0.1:${port}/`,
            'PATCH',
            JSON.stringify({ ref: 'main' }),
            { headers: { 'Content-Type': 'application/json' } },
        );

        assert.deepStrictEqual(result, { ok: true });
        server.close();
    });
});
