import * as vscode from 'vscode';
import { ControlPlane, ProviderInfo, WorkspaceInfo, CreateWorkspaceRequest } from './types';
import { ControlPlaneItem, WorkspaceItem, StatusItem } from './treeItems';
import { trimTrailingSlashes } from './utils';
import { httpGetJson, httpPostJson } from './http';

type TreeItem = ControlPlaneItem | WorkspaceItem | StatusItem;

export class QuickspacesTreeProvider implements vscode.TreeDataProvider<TreeItem> {
    private onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeItem | undefined | null | void>();
    onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    onControlPlaneChanged?: (label: string) => void;

    private controlPlanes: ControlPlane[] = [];
    private readonly workspaceStateKey = 'quickspaces.controlPlanes';
    private readonly workspaceCacheByControlPlaneUrl = new Map<string, WorkspaceInfo[]>();
    private readonly providerCacheByControlPlaneUrl = new Map<string, ProviderInfo[]>();
    private isInitialized = false;

    constructor(private context: vscode.ExtensionContext) {
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

    private async getAccessToken(cp: ControlPlane, createIfNone: boolean): Promise<string | undefined> {
        const scopes = this.getProviderScopes();

        try {
            const existingSession = await vscode.authentication.getSession('github', scopes, { createIfNone: false });
            if (existingSession) {
                return existingSession.accessToken;
            }

            if (!createIfNone) {
                return undefined;
            }

            const newSession = await vscode.authentication.getSession('github', scopes, { createIfNone: true });
            return newSession?.accessToken;
        } catch {
            return undefined;
        }
    }

    private getProviderScopes(): string[] {
        return ['repo'];
    }

    private getControlPlaneCacheKey(cp: ControlPlane): string {
        return trimTrailingSlashes(cp.url);
    }

    private async getAvailableProviders(controlPlaneOrUrl?: ControlPlane | string): Promise<ProviderInfo[]> {
        const controlPlaneUrl = typeof controlPlaneOrUrl === 'string'
            ? controlPlaneOrUrl
            : controlPlaneOrUrl?.url;

        if (controlPlaneUrl) {
            const normalizedUrl = trimTrailingSlashes(controlPlaneUrl);
            const cached = this.providerCacheByControlPlaneUrl.get(normalizedUrl);
            if (cached) {
                return cached;
            }

            const providers = await this.fetchProvidersFromControlPlane(normalizedUrl);
            if (providers.length) {
                this.providerCacheByControlPlaneUrl.set(normalizedUrl, providers);
                return providers;
            }
        }

        return [];
    }

    private async fetchProvidersFromControlPlane(controlPlaneUrl: string): Promise<ProviderInfo[]> {
        const candidatePaths = [
            '/api/v1/repo-providers',
            '/api/v1/providers',
        ];

        for (const path of candidatePaths) {
            const requestUrl = `${trimTrailingSlashes(controlPlaneUrl)}${path}`;
            try {
                const response = await httpGetJson<unknown>(requestUrl);
                const providers = this.normalizeProviderList(response);
                if (providers.length) {
                    return providers;
                }
            } catch {
                // try the next endpoint
            }
        }

        return [];
    }

    private normalizeProviderList(response: unknown): ProviderInfo[] {
        if (!Array.isArray(response)) {
            return [];
        }

        return response
            .map<ProviderInfo | undefined>(item => {
                if (!item || typeof item !== 'object') {
                    return undefined;
                }

                const provider = item as any;
                if (typeof provider.slug === 'string' && typeof provider.name === 'string') {
                    return {
                        id: provider.slug,
                        label: provider.name,
                        apiUrl: typeof provider.apiUrl === 'string' ? provider.apiUrl : undefined,
                        repositoryUrlTemplate: typeof provider.repositoryUrlTemplate === 'string' ? provider.repositoryUrlTemplate : undefined,
                        authorizationUrl: typeof provider.authorizationUrl === 'string' ? provider.authorizationUrl : undefined,
                        tokenUrl: typeof provider.tokenUrl === 'string' ? provider.tokenUrl : undefined,
                        scope: typeof provider.scope === 'string' ? provider.scope : undefined,
                        repoListUrl: typeof provider.repoListUrl === 'string' ? provider.repoListUrl : undefined,
                        repoListPath: typeof provider.repoListPath === 'string' ? provider.repoListPath : undefined,
                    };
                }

                return undefined;
            })
            .filter((provider): provider is ProviderInfo => provider !== undefined);
    }

    private getProviderInfo(providerId: string, cp?: ControlPlane): ProviderInfo | undefined {
        if (!providerId) {
            return undefined;
        }

        if (cp?.url) {
            const normalizedUrl = trimTrailingSlashes(cp.url);
            const providers = this.providerCacheByControlPlaneUrl.get(normalizedUrl);
            const match = providers?.find(p => p.id === providerId);
            if (match) {
                return match;
            }
        }

        for (const providers of this.providerCacheByControlPlaneUrl.values()) {
            const match = providers.find(p => p.id === providerId);
            if (match) {
                return match;
            }
        }

        return undefined;
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
            return undefined;
        }

        const url = await vscode.window.showInputBox({
            prompt: 'Control Plane URL',
            placeHolder: 'https://api.example.com',
        });
        if (!url) {
            return undefined;
        }

        const providers = await this.getAvailableProviders(url);
        let provider: string | undefined;
        let providerApiUrl: string | undefined;
        if (providers.length) {
            const picked = await vscode.window.showQuickPick(
                providers.map(provider => ({
                    label: provider.label,
                    description: provider.apiUrl,
                    provider,
                } as vscode.QuickPickItem & { provider: ProviderInfo })),
                { placeHolder: 'Select a repository provider for this control plane (optional)' },
            );
            provider = picked?.provider.id;
            providerApiUrl = picked?.provider.apiUrl;
        }

        const newControlPlane: ControlPlane = { name, url, provider, providerApiUrl };
        this.controlPlanes.push(newControlPlane);
        await this.saveControlPlanes();
        vscode.window.showInformationMessage(`Control plane "${name}" added${provider ? ` with provider ${provider}` : ''}`);
        return newControlPlane;
    }


    async configureControlPlane(controlPlaneOrItem: ControlPlane | ControlPlaneItem | vscode.TreeItem | undefined): Promise<void> {
        const controlPlane = this.resolveControlPlane(controlPlaneOrItem);
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
            vscode.window.showInformationMessage('Control plane URL updated');
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
        this.workspaceCacheByControlPlaneUrl.clear();
        this.onDidChangeTreeDataEmitter.fire();
    }

    async addWorkspace(controlPlaneOrItem: ControlPlane | ControlPlaneItem | vscode.TreeItem | undefined): Promise<void> {
        let controlPlane = this.resolveControlPlane(controlPlaneOrItem);
        if (!controlPlane) {
            return;
        }

        const providers = await this.getAvailableProviders(controlPlane);
        if (!providers.length) {
            vscode.window.showErrorMessage('No repository providers are configured for this control plane.');
            return;
        }

        let selectedProvider: ProviderInfo | undefined;
        const providerId = controlPlane.provider?.toLowerCase();
        if (providerId) {
            selectedProvider = providers.find(p => p.id === providerId);
        }

        if (!selectedProvider && providers.length === 1) {
            selectedProvider = providers[0];
        }

        if (!selectedProvider) {
            const providerPick = await vscode.window.showQuickPick(
                providers.map(provider => ({
                    label: provider.label,
                    description: provider.apiUrl,
                    provider,
                } as vscode.QuickPickItem & { provider: ProviderInfo })),
                { placeHolder: 'Select a repository provider' },
            );

            if (!providerPick) {
                return;
            }

            selectedProvider = providerPick.provider;
        }

        const currentControlPlaneName = controlPlane.name;
        const currentControlPlaneUrl = controlPlane.url;
        const storedControlPlane = this.controlPlanes.find(cp => cp.name === currentControlPlaneName && cp.url === currentControlPlaneUrl);
        if (storedControlPlane) {
            storedControlPlane.provider = selectedProvider.id;
            storedControlPlane.providerApiUrl = selectedProvider.apiUrl;
            await this.saveControlPlanes();
            controlPlane = storedControlPlane;
        } else {
            controlPlane.provider = selectedProvider.id;
            controlPlane.providerApiUrl = selectedProvider.apiUrl;
        }

        const providerToken = await this.getAccessToken(controlPlane, true);
        if (!providerToken) {
            vscode.window.showWarningMessage('Sign in to GitHub to access this repository provider.');
            return;
        }

        const repos = await this.listRepos(controlPlane, providerToken);
        if (!repos.length) {
            vscode.window.showInformationMessage('No repositories were found after login.');
            return;
        }

        const currentUsername = controlPlane.provider?.toLowerCase() === 'github'
            ? await this.getGitHubUsername(controlPlane, providerToken)
            : undefined;

        const quickPickItems = repos.map(repo => ({
            label: repo.repo_owner && repo.repo_name ? `${repo.repo_owner}/${repo.repo_name}` : repo.workspace_id ?? repo.ref ?? 'Repository',
            description: repo.actual_state || repo.desired_state || '',
            detail: repo.connection_url || repo.ref || '',
            workspace: repo,
        } as vscode.QuickPickItem & { workspace: WorkspaceInfo }));

        const ownedItems = currentUsername
            ? quickPickItems.filter(item => item.workspace.repo_owner === currentUsername)
            : quickPickItems;

        const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { workspace: WorkspaceInfo }>();
        quickPick.placeholder = 'Search or select a repository';
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        quickPick.items = ownedItems.length ? ownedItems : quickPickItems;

        quickPick.onDidChangeValue(value => {
            if (!value) {
                quickPick.items = ownedItems.length ? ownedItems : quickPickItems;
                return;
            }

            const filter = value.toLowerCase();
            quickPick.items = quickPickItems.filter(item =>
                item.label.toLowerCase().includes(filter)
                || item.description?.toLowerCase().includes(filter)
                || item.detail?.toLowerCase().includes(filter),
            );
        });

        const selectedRepo = await new Promise<vscode.QuickPickItem & { workspace: WorkspaceInfo } | undefined>(resolve => {
            quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
            quickPick.onDidHide(() => resolve(undefined));
            quickPick.show();
        });
        quickPick.dispose();

        if (!selectedRepo) {
            return;
        }

        const selectedWorkspace = selectedRepo.workspace;
        if (!selectedWorkspace.repo_owner || !selectedWorkspace.repo_name) {
            vscode.window.showErrorMessage('Selected repository does not expose owner/name metadata.');
            return;
        }

        const defaultRef = selectedWorkspace.ref || 'main';
        const ref = await vscode.window.showInputBox({
            prompt: 'Enter branch, tag, or commit reference for the workspace',
            placeHolder: 'main',
            value: defaultRef,
        });

        if (!ref) {
            return;
        }

        const workspaceRequest: CreateWorkspaceRequest = {
            repoOwner: selectedWorkspace.repo_owner,
            repoName: selectedWorkspace.repo_name,
            repoProvider: controlPlane.provider ?? 'github',
            ref,
        };

        const createUrl = `${trimTrailingSlashes(controlPlane.url)}/api/v1/workspaces`;

        try {
            await this.createWorkspace(createUrl, workspaceRequest, controlPlane, providerToken);
            vscode.window.showInformationMessage(`Workspace created for ${selectedWorkspace.repo_owner}/${selectedWorkspace.repo_name}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to create workspace.';
            vscode.window.showErrorMessage(`Failed to create workspace: ${message}`);
        }
    }

    private async listRepos(controlPlane: ControlPlane, token: string): Promise<WorkspaceInfo[]> {
        const repoUrl = this.getProviderRepoUrl(controlPlane);
        try {
            const repos = await httpGetJson<unknown>(repoUrl, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const normalized = this.normalizeProviderRepos(repos);
            if (normalized.length > 0) {
                return normalized;
            }
        } catch {
            // ignore and fall back
        }

        const fallbackUrl = `${trimTrailingSlashes(controlPlane.url)}/api/v1/workspaces`;
        try {
            const workspaces = await httpGetJson<WorkspaceInfo[]>(fallbackUrl, {
                headers: { Authorization: `Bearer ${token}` },
            });
            return Array.isArray(workspaces) ? workspaces : [];
        } catch {
            return [];
        }
    }

    private async getGitHubUsername(cp: ControlPlane, token: string): Promise<string | undefined> {
        const baseUrl = cp.providerApiUrl || 'https://api.github.com';
        if (!baseUrl) {
            return undefined;
        }

        try {
            const normalizedBaseUrl = trimTrailingSlashes(baseUrl);
            const user = await httpGetJson<{ login: string }>(`${normalizedBaseUrl}/user`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            return typeof user.login === 'string' ? user.login : undefined;
        } catch {
            return undefined;
        }
    }

    private async createWorkspace(
        url: string,
        requestBody: CreateWorkspaceRequest,
        cp: ControlPlane,
        token: string,
    ): Promise<void> {
        try {
            await httpPostJson<unknown>(url, JSON.stringify(requestBody), {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            });
        } catch (error) {
            if (error instanceof Error && /HTTP\s+401/i.test(error.message)) {
                const refreshedToken = await this.getAccessToken(cp, true);
                if (!refreshedToken) {
                    throw new Error('Control plane authentication required');
                }
                await httpPostJson<unknown>(url, JSON.stringify(requestBody), {
                    headers: {
                        Authorization: `Bearer ${refreshedToken}`,
                        'Content-Type': 'application/json',
                    },
                });
                return;
            }
            throw error;
        }
    }

    private getProviderRepoUrl(cp: ControlPlane): string {
        const providerId = cp.provider?.toLowerCase();
        const provider = this.getProviderInfo(providerId ?? '', cp);
        const baseUrl = provider?.apiUrl || cp.providerApiUrl || this.getProviderBaseUrl(providerId);

        if (!baseUrl) {
            return `${trimTrailingSlashes(cp.url)}/api/v1/repos`;
        }

        const normalized = trimTrailingSlashes(baseUrl);
        if (provider?.repoListUrl) {
            return provider.repoListUrl;
        }

        if (provider?.repoListPath) {
            return `${normalized}${provider.repoListPath.startsWith('/') ? '' : '/'}${provider.repoListPath}`;
        }

        if (this.isFullProviderRepoUrl(normalized)) {
            return normalized;
        }

        return normalized;
    }

    private getProviderBaseUrl(providerId: string | undefined): string | undefined {
        if (!providerId) {
            return undefined;
        }

        for (const providers of this.providerCacheByControlPlaneUrl.values()) {
            const provider = providers.find(provider => provider.id === providerId);
            if (provider?.apiUrl) {
                return provider.apiUrl;
            }
        }

        return undefined;
    }

    private isFullProviderRepoUrl(url: string): boolean {
        return /\/(?:repos|projects|repositories|user\/repos|_apis\/git\/repositories)(?:$|\?)/.test(url);
    }

    private normalizeProviderRepos(repos: unknown): WorkspaceInfo[] {
        if (!Array.isArray(repos)) {
            return [];
        }

        return repos
            .map(item => {
                if (!item || typeof item !== 'object') {
                    return undefined;
                }

                const repo = item as any;
                if (typeof repo.repo_owner === 'string' && typeof repo.repo_name === 'string') {
                    return repo as WorkspaceInfo;
                }
                if (repo.owner && typeof repo.owner.login === 'string' && typeof repo.name === 'string') {
                    return {
                        repo_owner: repo.owner.login,
                        repo_name: repo.name,
                        connection_url: repo.html_url || repo.url,
                        ref: repo.name,
                    };
                }
                if (typeof repo.path_with_namespace === 'string') {
                    const parts = repo.path_with_namespace.split('/');
                    return {
                        repo_owner: parts[0],
                        repo_name: parts.slice(1).join('/'),
                        connection_url: repo.web_url || repo.http_url_to_repo || repo.ssh_url_to_repo,
                        ref: repo.path_with_namespace,
                    };
                }
                if (typeof repo.name === 'string' && typeof repo.webUrl === 'string') {
                    return {
                        repo_owner: repo.project?.name,
                        repo_name: repo.name,
                        connection_url: repo.webUrl,
                        ref: repo.name,
                    };
                }
                return undefined;
            })
            .filter((repo): repo is WorkspaceInfo => Boolean(repo));
    }

    private resolveControlPlane(controlPlaneOrItem: ControlPlane | ControlPlaneItem | vscode.TreeItem | undefined): ControlPlane | undefined {
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
        const cached = this.workspaceCacheByControlPlaneUrl.get(this.getControlPlaneCacheKey(cp));
        if (cached) {
            return cached.map(workspace => new WorkspaceItem(workspace, cp.name));
        }

        const token = await this.getAccessToken(cp, true);
        if (!token) {
            return [new StatusItem('Authorization required', 'Authorize GitHub to access this repository provider', 'warning')];
        }

        const url = `${trimTrailingSlashes(cp.url)}/api/v1/workspaces`;
        try {
            const workspaces = await httpGetJson<WorkspaceInfo[]>(url, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const normalized = Array.isArray(workspaces) ? workspaces : [];
            this.workspaceCacheByControlPlaneUrl.set(this.getControlPlaneCacheKey(cp), normalized);

            if (!normalized.length) {
                return [new StatusItem('No workspaces found', 'The control plane returned an empty list', 'info')];
            }

            return normalized.map(workspace => new WorkspaceItem(workspace, cp.name));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unexpected error';
            if (typeof message === 'string' && /HTTP\s+(401|403)/.test(message)) {
                const refreshedToken = await this.getAccessToken(cp, true);
                if (!refreshedToken) {
                    return [new StatusItem('Authentication required', 'Sign in again to continue', 'warning')];
                }

                try {
                    const workspaces = await httpGetJson<WorkspaceInfo[]>(url, {
                        headers: { Authorization: `Bearer ${refreshedToken}` },
                    });
                    const normalized = Array.isArray(workspaces) ? workspaces : [];
                    this.workspaceCacheByControlPlaneUrl.set(this.getControlPlaneCacheKey(cp), normalized);

                    if (!normalized.length) {
                        return [new StatusItem('No workspaces found', 'The control plane returned an empty list', 'info')];
                    }

                    return normalized.map(workspace => new WorkspaceItem(workspace, cp.name));
                } catch (retryError) {
                    const retryMessage = retryError instanceof Error ? retryError.message : 'Unexpected error';
                    return [new StatusItem('Authentication required', retryMessage, 'warning')];
                }
            }
            return [new StatusItem('Unable to load workspaces', message, 'error')];
        }
    }
}

export { httpGetJson, httpPostJson };
export { ControlPlaneItem, WorkspaceItem, StatusItem } from './treeItems';
