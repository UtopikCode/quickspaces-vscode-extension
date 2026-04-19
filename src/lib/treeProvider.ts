import * as vscode from 'vscode';
import { ControlPlane, ProviderInfo, Workspace, WorkspaceCreateRequest } from './types';
import { trimTrailingSlashes } from './utils';
import { httpGetJson, httpPostJson } from './http';

const REPO_PROVIDERS: ProviderInfo[] = [
    { id: 'github', label: 'GitHub', apiUrl: 'https://api.github.com' },
    // { id: 'gitlab', label: 'GitLab', apiUrl: 'https://gitlab.com/api/v4' },
    // { id: 'azure', label: 'Azure DevOps', apiUrl: 'https://dev.azure.com' },
];

type TreeItem = ControlPlaneItem | WorkspaceItem | StatusItem;

export class QuickspacesTreeProvider implements vscode.TreeDataProvider<TreeItem> {
    private onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeItem | undefined | null | void>();
    onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    onControlPlaneChanged?: (label: string) => void;

    private controlPlanes: ControlPlane[] = [];
    private readonly workspaceStateKey = 'quickspaces.controlPlanes';
    private readonly sessionStateKey = 'quickspaces.controlPlaneSessions';
    private controlPlaneSessions = new Map<string, string>();
    private readonly workspaceCache = new Map<string, Workspace[]>();
    private readonly authClientId = 'quickspaces-vscode';
    private readonly authRequests = new Map<string, {
        controlPlane: ControlPlane;
        resolve: (token: string) => void;
        reject: (reason: unknown) => void;
        state: string;
        timeout: NodeJS.Timeout;
    }>();
    private isInitialized = false;

    constructor(private context: vscode.ExtensionContext) {
        this.updateContext();
        void this.loadControlPlanes();
    }

    private async loadControlPlanes(): Promise<void> {
        this.controlPlanes = this.context.workspaceState.get(this.workspaceStateKey, []);
        const sessionStore = this.context.workspaceState.get<Record<string, string>>(this.sessionStateKey, {});
        this.controlPlaneSessions = new Map(Object.entries(sessionStore));
        this.isInitialized = true;
        this.updateContext();
        this.refresh();
    }

    private async saveControlPlanes(): Promise<void> {
        await this.context.workspaceState.update(this.workspaceStateKey, this.controlPlanes);
        await this.context.workspaceState.update(this.sessionStateKey, Object.fromEntries(this.controlPlaneSessions.entries()));
        this.updateContext();
        this.refresh();
    }

    private async getAccessToken(cp: ControlPlane, createIfNone: boolean): Promise<string | undefined> {
        const providerId = cp.provider?.toLowerCase() ?? 'github';
        const scopes = this.getProviderScopes(providerId);

        try {
            const session = await vscode.authentication.getSession(providerId, scopes, { createIfNone });
            return session?.accessToken;
        } catch {
            return undefined;
        }
    }

    private getProviderScopes(providerId: string): string[] {
        switch (providerId) {
            case 'github':
                return ['repo'];
            case 'gitlab':
                return ['read_api'];
            case 'azure':
                return ['vso.code'];
            default:
                return [];
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
            return undefined;
        }

        const url = await vscode.window.showInputBox({
            prompt: 'Control Plane URL',
            placeHolder: 'https://api.example.com',
        });
        if (!url) {
            return undefined;
        }

        const providers = await this.getAvailableProviders();
        let provider: string | undefined;
        let providerApiUrl: string | undefined;
        if (providers.length) {
            const picked = await vscode.window.showQuickPick(
                providers.map(provider => ({
                    label: provider.label,
                    description: provider.apiUrl,
                    provider,
                } as vscode.QuickPickItem & { provider: ProviderInfo })),
                { placeHolder: 'Select an auth provider for this control plane (optional)' },
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

    private async getAvailableProviders(): Promise<ProviderInfo[]> {
        return REPO_PROVIDERS;
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
        this.workspaceCache.clear();
        this.onDidChangeTreeDataEmitter.fire();
    }

    async addWorkspace(controlPlaneOrItem: ControlPlane | ControlPlaneItem | vscode.TreeItem | undefined): Promise<void> {
        let controlPlane = this.normalizeControlPlane(controlPlaneOrItem);
        if (!controlPlane) {
            return;
        }

        const providers = await this.getAvailableProviders();
        if (!providers.length) {
            vscode.window.showErrorMessage('No auth providers are configured for this extension.');
            return;
        }

        const providerPick = await vscode.window.showQuickPick(
            providers.map(provider => ({
                label: provider.label,
                description: provider.apiUrl,
                provider,
            } as vscode.QuickPickItem & { provider: ProviderInfo })),
            { placeHolder: 'Select an auth provider' },
        );

        if (!providerPick) {
            return;
        }

        const selectedProvider = providerPick.provider;
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
            const providerLabel = controlPlane.provider ?? 'GitHub';
            vscode.window.showWarningMessage(`Authorize ${providerLabel} to access this repository provider.`);
            return;
        }

        const repos = await this.listRepos(controlPlane, providerToken);
        if (!repos.length) {
            vscode.window.showInformationMessage('No repositories were found after login.');
            return;
        }

        const providerId = controlPlane.provider?.toLowerCase() ?? 'github';
        const currentUsername = providerId === 'github'
            ? await this.getGitHubUsername(controlPlane, providerToken)
            : undefined;

        const quickPickItems = repos.map(repo => ({
            label: repo.repo_owner && repo.repo_name ? `${repo.repo_owner}/${repo.repo_name}` : repo.workspace_id ?? repo.ref ?? 'Repository',
            description: repo.actual_state || repo.desired_state || '',
            detail: repo.connection_url || repo.ref || '',
            workspace: repo,
        } as vscode.QuickPickItem & { workspace: Workspace }));

        const ownedItems = currentUsername
            ? quickPickItems.filter(item => item.workspace.repo_owner === currentUsername)
            : quickPickItems;

        const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { workspace: Workspace }>();
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

        const selectedRepo = await new Promise<vscode.QuickPickItem & { workspace: Workspace } | undefined>(resolve => {
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

        const workspaceRequest: WorkspaceCreateRequest = {
            repoOwner: selectedWorkspace.repo_owner,
            repoName: selectedWorkspace.repo_name,
            repoProvider: selectedProvider.id,
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

    private async listRepos(controlPlane: ControlPlane, token: string): Promise<Workspace[]> {
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
            const workspaces = await httpGetJson<Workspace[]>(fallbackUrl, {
                headers: { Authorization: `Bearer ${token}` },
            });
            return Array.isArray(workspaces) ? workspaces : [];
        } catch {
            return [];
        }
    }

    private async getGitHubUsername(cp: ControlPlane, token: string): Promise<string | undefined> {
        const baseUrl = cp.providerApiUrl || this.getProviderBaseUrl('github');
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

    handleUri(uri: vscode.Uri): void {
        if (!uri.path.startsWith('/quickspaces-auth')) {
            return;
        }

        const query = new URLSearchParams(uri.query);
        const code = query.get('code');
        const state = query.get('state');

        if (!code || !state) {
            return;
        }

        for (const [key, request] of this.authRequests.entries()) {
            if (request.state !== state) {
                continue;
            }

            clearTimeout(request.timeout);
            this.authRequests.delete(key);
            void this.exchangeControlPlaneCode(request.controlPlane, code, uri.toString())
                .then(token => {
                    if (token) {
                        this.setControlPlaneSession(request.controlPlane, token);
                        request.resolve(token);
                    } else {
                        request.reject(new Error('Failed to exchange auth code for session token'));
                    }
                })
                .catch(request.reject);
            return;
        }
    }

    private getControlPlaneKey(cp: ControlPlane): string {
        return `${trimTrailingSlashes(cp.url)}|${cp.provider ?? ''}`;
    }

    private getExtensionId(): string {
        return vscode.extensions.getExtension('UtopikCode.quickspaces')?.id ?? 'quickspaces';
    }

    private getControlPlaneSession(cp: ControlPlane): string | undefined {
        return this.controlPlaneSessions.get(this.getControlPlaneKey(cp));
    }

    private setControlPlaneSession(cp: ControlPlane, token: string): void {
        this.controlPlaneSessions.set(this.getControlPlaneKey(cp), token);
        void this.saveControlPlanes();
    }

    private clearControlPlaneSession(cp: ControlPlane): void {
        this.controlPlaneSessions.delete(this.getControlPlaneKey(cp));
        void this.saveControlPlanes();
    }

    private async ensureControlPlaneSession(cp: ControlPlane): Promise<string | undefined> {
        const existingToken = this.getControlPlaneSession(cp);
        if (existingToken) {
            return existingToken;
        }

        const state = `${Math.random().toString(36).slice(2)}-${Date.now()}`;
        const redirectUri = `vscode://${this.getExtensionId()}/quickspaces-auth`;
        const loginUrl = `${trimTrailingSlashes(cp.url)}/api/v1/auth/github-app/login` +
            `?response_type=code&client_id=${encodeURIComponent(this.authClientId)}` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&state=${encodeURIComponent(state)}` +
            `&scope=${encodeURIComponent('user repo')}`;

        const promise = new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.authRequests.delete(this.getControlPlaneKey(cp));
                reject(new Error('Control plane authentication timed out'));
            }, 2 * 60 * 1000);

            this.authRequests.set(this.getControlPlaneKey(cp), {
                controlPlane: cp,
                resolve,
                reject,
                state,
                timeout,
            });
        });

        await vscode.env.openExternal(vscode.Uri.parse(loginUrl));

        try {
            return await promise;
        } catch (error) {
            vscode.window.showErrorMessage('Control plane login failed. Please try again.');
            return undefined;
        }
    }

    private async exchangeControlPlaneCode(cp: ControlPlane, code: string, redirectUri: string): Promise<string | undefined> {
        const tokenUrl = `${trimTrailingSlashes(cp.url)}/api/v1/auth/github/token`;
        const body = `grant_type=authorization_code&code=${encodeURIComponent(code)}` +
            `&client_id=${encodeURIComponent(this.authClientId)}` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}`;

        try {
            const response = await httpPostJson<{ token?: string }>(tokenUrl, body, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            });
            return typeof response?.token === 'string' ? response.token : undefined;
        } catch {
            return undefined;
        }
    }

    private async createWorkspace(
        url: string,
        requestBody: WorkspaceCreateRequest,
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
        const baseUrl = cp.providerApiUrl || this.getProviderBaseUrl(providerId);

        if (!baseUrl) {
            return `${trimTrailingSlashes(cp.url)}/api/v1/repos`;
        }

        const normalized = trimTrailingSlashes(baseUrl);
        if (this.isFullProviderRepoUrl(normalized)) {
            return normalized;
        }

        switch (providerId) {
            case 'github':
                return `${normalized}/user/repos?per_page=100`;
            case 'gitlab':
                return `${normalized}/projects?membership=true&simple=true`;
            case 'azure':
                return `${normalized}/_apis/git/repositories?api-version=7.1-preview.1`;
            default:
                return normalized;
        }
    }

    private getProviderBaseUrl(providerId: string | undefined): string | undefined {
        return REPO_PROVIDERS.find(provider => provider.id === providerId)?.apiUrl;
    }

    private isFullProviderRepoUrl(url: string): boolean {
        return /\/(?:repos|projects|repositories|user\/repos|_apis\/git\/repositories)(?:$|\?)/.test(url);
    }

    private normalizeProviderRepos(repos: unknown): Workspace[] {
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
                    return repo as Workspace;
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
            .filter((repo): repo is Workspace => Boolean(repo));
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

        const token = await this.getAccessToken(cp, true);
        if (!token) {
            const providerLabel = cp.provider ? cp.provider : 'GitHub';
            return [new StatusItem('Authorization required', `Authorize ${providerLabel} to access this repository provider`, 'warning')];
        }

        const url = `${trimTrailingSlashes(cp.url)}/api/v1/workspaces`;
        try {
            const workspaces = await httpGetJson<Workspace[]>(url, {
                headers: { Authorization: `Bearer ${token}` },
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
                return [new StatusItem('Authentication required', 'Sign in again to continue', 'warning')];
            }
            return [new StatusItem('Unable to load workspaces', message, 'error')];
        }
    }
}

export class ControlPlaneItem {
    constructor(public readonly controlPlane: ControlPlane) { }

    getTreeItem(): vscode.TreeItem {
        const item = new vscode.TreeItem(this.controlPlane.name, vscode.TreeItemCollapsibleState.Expanded);
        const providerLabel = this.controlPlane.provider ? ` (${this.controlPlane.provider})` : '';
        item.tooltip = `${this.controlPlane.url}${providerLabel}`;
        item.iconPath = new vscode.ThemeIcon('server');
        item.contextValue = 'controlPlane';
        return item;
    }
}

export class WorkspaceItem {
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

export class StatusItem {
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

export { httpGetJson, httpPostJson };
