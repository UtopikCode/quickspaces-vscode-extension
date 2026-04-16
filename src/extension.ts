// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const provider = new QuickspacesTreeProvider(context);

    const treeView = vscode.window.createTreeView('quickspacesView', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });

    // Update view description and context based on configured control planes
    provider.onControlPlaneChanged = (label: string) => {
        treeView.description = label;
        vscode.commands.executeCommand('setContext', 'quickspaces.hasControlPlane', !!label);
    };

    context.subscriptions.push(treeView);

    context.subscriptions.push(
        vscode.commands.registerCommand('quickspaces.addControlPlane', async () => {
            const addedControlPlane = await provider.addControlPlane();
            if (addedControlPlane) {
                const treeItem = new ControlPlaneItem(addedControlPlane);
                void treeView.reveal(treeItem, { expand: true });
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('quickspaces.configureControlPlane', async (controlPlaneOrItem: ControlPlane | ControlPlaneItem | vscode.TreeItem | undefined) => {
            await provider.configureControlPlane(controlPlaneOrItem);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('quickspaces.refresh', () => {
            provider.refresh();
            vscode.window.showInformationMessage('Quickspaces refreshed');
        }),
    );
}

export function deactivate() { }

interface ControlPlane {
    name: string;
    url: string;
    provider?: string;
}

interface Workspace {
    workspace_id?: string;
    repo_owner?: string;
    repo_name?: string;
    ref?: string;
    actual_state?: string;
    desired_state?: string;
    connection_url?: string;
}

interface AuthSession {
    token: string;
    provider: string;
    expiresAt?: string;
}

type TreeItem = ControlPlaneItem | WorkspaceItem | StatusItem;

class QuickspacesTreeProvider implements vscode.TreeDataProvider<TreeItem> {
    private onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeItem | undefined | null | void>();
    onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    onControlPlaneChanged?: (label: string) => void;

    private controlPlanes: ControlPlane[] = [];
    private readonly workspaceStateKey = 'quickspaces.controlPlanes';
    private readonly authSessionKey = 'quickspaces.authSession';
    private readonly workspaceCache = new Map<string, Workspace[]>();
    private authCallbackRequest?: {
        resolve: (result: boolean) => void;
        reject: (error: any) => void;
        state: string;
        provider: string;
        cp: ControlPlane;
        timeout: ReturnType<typeof setTimeout>;
    };
    private isInitialized = false;

    constructor(private context: vscode.ExtensionContext) {
        context.subscriptions.push(vscode.window.registerUriHandler({
            handleUri: uri => void this.handleUri(uri),
        }));

        this.updateContext();
        void this.loadControlPlanes();
    }

    private async loadControlPlanes(): Promise<void> {
        this.controlPlanes = this.context.workspaceState.get(this.workspaceStateKey, []);
        this.isInitialized = true;
        this.updateContext();
        this.refresh();
    }

    private async saveControlPlanes(): Promise<void> {
        await this.context.workspaceState.update(this.workspaceStateKey, this.controlPlanes);
        this.updateContext();
        this.refresh();
    }

    private getAuthSession(): AuthSession | undefined {
        const session = this.context.workspaceState.get<AuthSession>(this.authSessionKey);
        if (!session) {
            return undefined;
        }

        if (session.expiresAt && new Date(session.expiresAt) <= new Date()) {
            return undefined;
        }

        return session;
    }

    private async saveAuthSession(session: AuthSession): Promise<void> {
        await this.context.workspaceState.update(this.authSessionKey, session);
    }

    private async clearAuthSession(): Promise<void> {
        await this.context.workspaceState.update(this.authSessionKey, undefined);
    }

    private async handleUri(uri: vscode.Uri): Promise<void> {
        if (!this.authCallbackRequest) {
            return;
        }

        const query = new URLSearchParams(uri.query);
        const code = query.get('code');
        const returnedState = query.get('state');
        const provider = this.authCallbackRequest.provider;

        if (!code || returnedState !== this.authCallbackRequest.state) {
            this.authCallbackRequest.resolve(false);
            return;
        }

        try {
            const session = await this.exchangeAuthCode(this.authCallbackRequest.cp, provider, code);
            await this.saveAuthSession(session);
            this.authCallbackRequest.resolve(true);
        } catch (error) {
            this.authCallbackRequest.reject(error);
        } finally {
            clearTimeout(this.authCallbackRequest.timeout);
            this.authCallbackRequest = undefined;
        }
    }

    private controlPlaneDescription(): string {
        const count = this.controlPlanes.length;
        return count ? `${count} control plane${count === 1 ? '' : 's'}` : '';
    }

    private updateContext(): void {
        vscode.commands.executeCommand('setContext', 'quickspaces.hasControlPlane', this.controlPlanes.length > 0);
        vscode.commands.executeCommand('setContext', 'quickspaces.isInitializing', !this.isInitialized);
        this.onControlPlaneChanged?.(this.controlPlaneDescription());
    }

    async addControlPlane(): Promise<ControlPlane | undefined> {
        const name = await vscode.window.showInputBox({
            prompt: 'Control Plane Name',
            placeHolder: 'e.g., Production, Staging',
        });
        if (!name) {
            return undefined;
        }

        if (this.controlPlanes.find(cp => cp.name === name)) {
            vscode.window.showErrorMessage(`Control plane with name "${name}" already exists`);
            return;
        }

        const url = await vscode.window.showInputBox({
            prompt: 'Control Plane URL',
            placeHolder: 'https://api.example.com',
        });
        if (!url) {
            return;
        }

        const providers = await this.getAuthProviders(url);
        let provider: string | undefined;
        if (providers.length) {
            const picked = await vscode.window.showQuickPick(
                providers.map(value => ({ label: value })),
                { placeHolder: 'Select an auth provider for this control plane (optional)' },
            );
            provider = picked?.label;
        }

        const newControlPlane: ControlPlane = { name, url, provider };
        this.controlPlanes.push(newControlPlane);
        await this.saveControlPlanes();
        vscode.window.showInformationMessage(`Control plane "${name}" added${provider ? ` with provider ${provider}` : ''}`);
        return newControlPlane;
    }

    private async getAuthProviders(controlPlaneUrl: string): Promise<string[]> {
        const endpoint = `${controlPlaneUrl.replace(/\/+$/, '')}/api/v1/auth/providers`;
        try {
            const response = await httpGetJson<unknown>(endpoint);
            if (!Array.isArray(response)) {
                return [];
            }

            return response
                .map(provider => {
                    if (typeof provider === 'string') {
                        return provider;
                    }
                    if (provider && typeof provider === 'object') {
                        if (typeof (provider as any).name === 'string') {
                            return (provider as any).name;
                        }
                        if (typeof (provider as any).provider === 'string') {
                            return (provider as any).provider;
                        }
                        if (typeof (provider as any).id === 'string') {
                            return (provider as any).id;
                        }
                    }
                    return undefined;
                })
                .filter((value): value is string => Boolean(value));
        } catch {
            return [];
        }
    }

    async configureControlPlane(controlPlaneOrItem: ControlPlane | ControlPlaneItem | vscode.TreeItem | undefined): Promise<void> {
        const controlPlane = this.normalizeControlPlane(controlPlaneOrItem);
        if (!controlPlane) {
            return;
        }

        const action = await vscode.window.showQuickPick([
            { label: 'Rename', description: 'Update the control plane name' },
            { label: 'Update URL', description: 'Change the control plane API URL' },
            { label: 'Remove', description: 'Delete this control plane' },
        ], {
            placeHolder: 'Choose a control plane configuration action',
        });

        if (!action) {
            return;
        }

        const index = this.controlPlanes.findIndex(cp => cp.name === controlPlane.name && cp.url === controlPlane.url);
        if (index === -1) {
            vscode.window.showErrorMessage('Unable to find the selected control plane');
            return;
        }

        if (action.label === 'Rename') {
            const newName = await vscode.window.showInputBox({
                prompt: 'New Control Plane Name',
                value: controlPlane.name,
            });
            if (!newName) {
                return;
            }
            if (this.controlPlanes.find(cp => cp.name === newName && cp !== controlPlane)) {
                vscode.window.showErrorMessage(`Control plane with name "${newName}" already exists`);
                return;
            }
            this.controlPlanes[index].name = newName;
            await this.saveControlPlanes();
            vscode.window.showInformationMessage(`Control plane renamed to "${newName}"`);
            return;
        }

        if (action.label === 'Update URL') {
            const newUrl = await vscode.window.showInputBox({
                prompt: 'New Control Plane URL',
                value: controlPlane.url,
            });
            if (!newUrl) {
                return;
            }
            this.controlPlanes[index].url = newUrl;
            await this.saveControlPlanes();
            vscode.window.showInformationMessage(`Control plane URL updated`);
            return;
        }

        if (action.label === 'Remove') {
            this.controlPlanes.splice(index, 1);
            await this.saveControlPlanes();
            vscode.window.showInformationMessage(`Control plane "${controlPlane.name}" removed`);
        }
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element.getTreeItem();
    }

    getParent(element: TreeItem): TreeItem | null {
        if (element instanceof WorkspaceItem) {
            const parent = this.controlPlanes.find(cp => cp.name === element.controlPlaneName);
            return parent ? new ControlPlaneItem(parent) : null;
        }
        return null;
    }

    getChildren(element?: TreeItem): Thenable<TreeItem[]> {
        if (!this.isInitialized) {
            return Promise.resolve([
                new StatusItem('Loading control planes...', 'Please wait while the extension initializes', 'sync~spin'),
            ]);
        }

        if (!this.controlPlanes.length) {
            return Promise.resolve([]);
        }

        if (!element) {
            return Promise.resolve(this.controlPlanes.map(cp => new ControlPlaneItem(cp)));
        }

        if (element instanceof ControlPlaneItem) {
            return this.getWorkspaceChildren(element.controlPlane);
        }

        return Promise.resolve([]);
    }

    refresh(): void {
        this.workspaceCache.clear();
        this.onDidChangeTreeDataEmitter.fire();
    }

    private normalizeControlPlane(controlPlaneOrItem: ControlPlane | ControlPlaneItem | vscode.TreeItem | undefined): ControlPlane | undefined {
        if (!controlPlaneOrItem) {
            return undefined;
        }

        if (controlPlaneOrItem instanceof ControlPlaneItem) {
            return controlPlaneOrItem.controlPlane;
        }

        const possible = controlPlaneOrItem as ControlPlane;
        if (possible.name && possible.url) {
            return possible;
        }

        const treeItem = controlPlaneOrItem as vscode.TreeItem;
        if (treeItem.label && typeof treeItem.description === 'string') {
            return {
                name: typeof treeItem.label === 'string' ? treeItem.label : String(treeItem.label),
                url: treeItem.description,
            };
        }

        return undefined;
    }

    private async getWorkspaceChildren(cp: ControlPlane): Promise<TreeItem[]> {
        const cached = this.workspaceCache.get(cp.name);
        if (cached) {
            return cached.map(workspace => new WorkspaceItem(workspace, cp.name));
        }

        let authSession = this.getAuthSession();
        if (!authSession) {
            const signedIn = await this.signIn(cp);
            if (!signedIn) {
                const loginProvider = cp.provider ?? 'github';
                return [new StatusItem(
                    'Sign-in required',
                    `Open browser to ${loginProvider} login and wait for completion`,
                    'warning',
                )];
            }
            authSession = this.getAuthSession();
        }

        if (!authSession) {
            return [new StatusItem('Unable to verify authentication', 'Authentication did not complete successfully', 'error')];
        }

        const url = `${cp.url.replace(/\/+$/, '')}/api/v1/workspaces`;
        try {
            const workspaces = await httpGetJson<Workspace[]>(url, {
                headers: { Authorization: `Bearer ${authSession.token}` },
            });
            const normalized = Array.isArray(workspaces) ? workspaces : [];
            this.workspaceCache.set(cp.name, normalized);

            if (!normalized.length) {
                return [new StatusItem('No workspaces found', 'The control plane returned an empty list', 'info')];
            }

            return normalized.map(workspace => new WorkspaceItem(workspace, cp.name));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unexpected error';
            if (typeof message === 'string' && /HTTP\s+(401|403)/.test(message)) {
                await this.clearAuthSession();
                const loggedIn = await this.signIn(cp);
                if (loggedIn) {
                    return this.getWorkspaceChildren(cp);
                }
                return [new StatusItem('Sign-in required', 'Authentication expired or is invalid', 'warning')];
            }
            return [new StatusItem('Unable to load workspaces', message, 'error')];
        }
    }

    private async signIn(cp: ControlPlane): Promise<boolean> {
        const provider = cp.provider ?? 'github';
        const state = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const callbackUri = vscode.Uri.parse(`vscode://${this.context.extension.id}/callback`);
        const loginUrl = `${cp.url.replace(/\/+$/, '')}/api/v1/auth/${provider}/login?redirect_uri=${encodeURIComponent(callbackUri.toString())}&state=${encodeURIComponent(state)}`;

        if (this.authCallbackRequest) {
            clearTimeout(this.authCallbackRequest.timeout);
            this.authCallbackRequest.reject(new Error('Auth flow restarted'));
            this.authCallbackRequest = undefined;
        }

        const resultPromise = new Promise<boolean>((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.authCallbackRequest) {
                    this.authCallbackRequest = undefined;
                }
                resolve(false);
            }, 120000);

            this.authCallbackRequest = {
                resolve,
                reject,
                state,
                provider,
                cp,
                timeout,
            };
        });

        void vscode.env.openExternal(vscode.Uri.parse(loginUrl));
        return resultPromise;
    }

    private async exchangeAuthCode(cp: ControlPlane, provider: string, code: string): Promise<AuthSession> {
        const endpoint = `${cp.url.replace(/\/+$/, '')}/api/v1/auth/${provider}/token`;
        const response = await httpPostJson<{ access_token: string; expires_in: number }>(endpoint, new URLSearchParams({ code }).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        return {
            token: response.access_token,
            provider,
            expiresAt: new Date(Date.now() + response.expires_in * 1000).toISOString(),
        };
    }
}

class ControlPlaneItem {
    constructor(public readonly controlPlane: ControlPlane) { }

    getTreeItem(): vscode.TreeItem {
        const item = new vscode.TreeItem(this.controlPlane.name, vscode.TreeItemCollapsibleState.Collapsed);
        const providerLabel = this.controlPlane.provider ? ` (${this.controlPlane.provider})` : '';
        // item.description = `${this.controlPlane.url}${providerLabel}`;
        item.tooltip = `${this.controlPlane.url}${providerLabel}`;
        item.iconPath = new vscode.ThemeIcon('server');
        item.contextValue = 'controlPlane';
        return item;
    }
}

class WorkspaceItem {
    constructor(public readonly workspace: Workspace, public readonly controlPlaneName: string) { }

    getTreeItem(): vscode.TreeItem {
        const label = this.workspace.repo_owner && this.workspace.repo_name
            ? `${this.workspace.repo_owner}/${this.workspace.repo_name}`
            : this.workspace.workspace_id ?? this.workspace.ref ?? 'Workspace';

        const description = this.workspace.actual_state || this.workspace.desired_state || '';
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = description;
        item.tooltip = this.workspace.connection_url || this.workspace.ref || label;
        item.iconPath = new vscode.ThemeIcon('repo');
        item.contextValue = 'workspace';
        return item;
    }
}

class StatusItem {
    constructor(
        public readonly label: string,
        public readonly description: string,
        public readonly iconName: string,
    ) { }

    getTreeItem(): vscode.TreeItem {
        const item = new vscode.TreeItem(this.label);
        item.description = this.description;
        item.tooltip = this.description;
        item.iconPath = new vscode.ThemeIcon(this.iconName);
        return item;
    }
}

function httpGetJson<T>(url: string, options?: { headers?: Record<string, string> }): Promise<T> {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https://') ? https : http;
        const headers: Record<string, string> = {
            Accept: 'application/json',
            ...options?.headers,
        };

        const req = client.get(url, { headers }, res => {
            let body = '';

            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(body));
                    } catch (err) {
                        reject(new Error('Invalid JSON response'));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || 'Error'}`));
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

function httpPostJson<T>(url: string, body: string, options?: { headers?: Record<string, string> }): Promise<T> {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https://') ? https : http;
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body).toString(),
            ...options?.headers,
        };

        const req = client.request(url, { method: 'POST', headers }, res => {
            let responseBody = '';

            res.on('data', chunk => { responseBody += chunk; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(responseBody));
                    } catch (err) {
                        reject(new Error('Invalid JSON response'));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || 'Error'}`));
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

export type { ControlPlane, Workspace, AuthSession };
export { QuickspacesTreeProvider, ControlPlaneItem, WorkspaceItem, StatusItem, httpGetJson, httpPostJson };
