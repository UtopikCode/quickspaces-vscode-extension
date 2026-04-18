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

const originalRegisterUriHandler = vscode.window.registerUriHandler;

function disableUriHandlerRegistration(): void {
    (vscode.window as any).registerUriHandler = () => ({ dispose: () => undefined });
}

function restoreUriHandlerRegistration(): void {
    (vscode.window as any).registerUriHandler = originalRegisterUriHandler;
}

suite('QuickspacesTreeProvider Tests', () => {
    suiteSetup(() => {
        disableUriHandlerRegistration();
    });

    suiteTeardown(() => {
        restoreUriHandlerRegistration();
    });
    const fakeContext = {
        workspaceState: new FakeWorkspaceState(),
        subscriptions: [] as vscode.Disposable[],
        extension: { id: 'test.extension' },
    } as unknown as vscode.ExtensionContext;

    test('normalizeControlPlane handles ControlPlane and tree items', () => {
        const provider = new QuickspacesTreeProvider(fakeContext);

        const cp: ControlPlane = { name: 'Test', url: 'https://example.com', provider: 'github' };
        assert.deepStrictEqual(provider['normalizeControlPlane'](cp), cp);

        const cpItem = new ControlPlaneItem(cp);
        assert.deepStrictEqual(provider['normalizeControlPlane'](cpItem), cp);

        const treeItem = new vscode.TreeItem('Tree Label');
        treeItem.description = 'https://example.com';
        assert.deepStrictEqual(provider['normalizeControlPlane'](treeItem), {
            name: 'Tree Label',
            url: 'https://example.com',
        });

        const invalidItem = new vscode.TreeItem('No Description');
        assert.strictEqual(provider['normalizeControlPlane'](invalidItem), undefined);
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

    test('getAvailableProviders returns the built-in provider list', async () => {
        const provider = new QuickspacesTreeProvider(fakeContext);
        const providers = await provider['getAvailableProviders']();
        assert.deepStrictEqual(providers, [
            { id: 'github', label: 'GitHub', apiUrl: 'https://api.github.com' },
            { id: 'gitlab', label: 'GitLab', apiUrl: 'https://gitlab.com/api/v4' },
            { id: 'azure', label: 'Azure DevOps', apiUrl: 'https://dev.azure.com' },
        ]);
    });

    test('getAccessToken requests provider-specific scopes', async () => {
        const originalGetSession = (vscode.authentication as any).getSession;
        let receivedProviderId: string | undefined;
        let receivedScopes: readonly string[] | undefined;

        (vscode.authentication as any).getSession = async (providerId: string, scopes: readonly string[], options: { createIfNone: boolean }) => {
            receivedProviderId = providerId;
            receivedScopes = scopes;
            return { accessToken: 'test-token' } as any;
        };

        const provider = new QuickspacesTreeProvider(fakeContext);
        const token = await provider['getAccessToken']({ name: 'Test', url: 'https://example.com', provider: 'github' }, true);

        assert.strictEqual(token, 'test-token');
        assert.strictEqual(receivedProviderId, 'github');
        assert.deepStrictEqual(receivedScopes, ['repo']);

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
});
