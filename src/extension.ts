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
            await provider.addControlPlane();
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

type TreeItem = ControlPlaneItem | WorkspaceItem | StatusItem;

class QuickspacesTreeProvider implements vscode.TreeDataProvider<TreeItem> {
    private onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeItem | undefined | null | void>();
    onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    onControlPlaneChanged?: (label: string) => void;

    private controlPlanes: ControlPlane[] = [];
    private readonly workspaceStateKey = 'quickspaces.controlPlanes';
    private readonly workspaceCache = new Map<string, Workspace[]>();
    private isInitialized = false;

    constructor(private context: vscode.ExtensionContext) {
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

    private controlPlaneDescription(): string {
        const count = this.controlPlanes.length;
        return count ? `${count} control plane${count === 1 ? '' : 's'}` : '';
    }

    private updateContext(): void {
        vscode.commands.executeCommand('setContext', 'quickspaces.hasControlPlane', this.controlPlanes.length > 0);
        vscode.commands.executeCommand('setContext', 'quickspaces.isInitializing', !this.isInitialized);
        this.onControlPlaneChanged?.(this.controlPlaneDescription());
    }

    async addControlPlane(): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'Control Plane Name',
            placeHolder: 'e.g., Production, Staging',
        });
        if (!name) {
            return;
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

        this.controlPlanes.push({ name, url, provider });
        await this.saveControlPlanes();
        vscode.window.showInformationMessage(`Control plane "${name}" added${provider ? ` with provider ${provider}` : ''}`);
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

    getChildren(element?: TreeItem): Thenable<TreeItem[]> {
        if (!this.isInitialized) {
            return Promise.resolve([
                new StatusItem('Loading control planes...', 'Please wait while the extension initializes', 'sync~spin'),
            ]);
        }

        if (!this.controlPlanes.length) {
            return Promise.resolve([
                new StatusItem('No control plane configured', 'Add one using the view actions', 'info'),
            ]);
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
            return cached.map(workspace => new WorkspaceItem(workspace));
        }

        const loggedIn = await this.ensureLoggedIn(cp);
        if (!loggedIn) {
            const loginProvider = cp.provider ?? 'github';
            const loginUrl = `${cp.url.replace(/\/+$/, '')}/api/v1/auth/${loginProvider}/login`;
            vscode.env.openExternal(vscode.Uri.parse(loginUrl));
            return [new StatusItem(
                'Sign-in required',
                `Open browser to ${loginProvider} login and refresh when complete`,
                'warning',
            )];
        }

        const url = `${cp.url.replace(/\/+$/, '')}/api/v1/workspaces`;
        try {
            const workspaces = await httpGetJson<Workspace[]>(url);
            const normalized = Array.isArray(workspaces) ? workspaces : [];
            this.workspaceCache.set(cp.name, normalized);

            if (!normalized.length) {
                return [new StatusItem('No workspaces found', 'The control plane returned an empty list', 'info')];
            }

            return normalized.map(workspace => new WorkspaceItem(workspace));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unexpected error';
            return [new StatusItem('Unable to load workspaces', message, 'error')];
        }
    }

    private async ensureLoggedIn(cp: ControlPlane): Promise<boolean> {
        const url = `${cp.url.replace(/\/+$/, '')}/api/v1/status`;
        return new Promise<boolean>(resolve => {
            const client = url.startsWith('https://') ? https : http;
            const req = client.get(url, { headers: { Accept: 'application/json' } }, res => {
                if (res.statusCode === 401) {
                    resolve(false);
                } else {
                    resolve(true);
                }
            });

            req.on('error', () => resolve(true));
            req.end();
        });
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
    constructor(public readonly workspace: Workspace) { }

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

function httpGetJson<T>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https://') ? https : http;
        const req = client.get(url, { headers: { Accept: 'application/json' } }, res => {
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
