import * as vscode from 'vscode';
import { ControlPlane, ProviderInfo, WorkspaceInfo, CreateWorkspaceRequest } from './types';
import { ControlPlaneItem, WorkspaceItem, StatusItem } from './treeItems';
import { DEFAULT_REPO_PROVIDERS } from './repoProviders';
import { trimLeadingSlashes, trimTrailingSlashes } from './utils';
import { httpGetJson, httpPostJson, httpRequestJson } from './http';

type TreeItem = ControlPlaneItem | WorkspaceItem | StatusItem;

export class QuickspacesTreeProvider implements vscode.TreeDataProvider<TreeItem> {
    private onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeItem | undefined | null | void>();
    onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    onControlPlaneChanged?: (label: string) => void;

    private controlPlanes: ControlPlane[] = [];
    private readonly workspaceStateKey = 'quickspaces.controlPlanes';
    private readonly workspaceCacheByControlPlaneUrl = new Map<string, WorkspaceInfo[]>();
    private readonly providerCacheByControlPlaneUrl = new Map<string, ProviderInfo[]>();
    private readonly outputChannel: vscode.OutputChannel;
    private hasShownOutputChannel = false;
    private isInitialized = false;

    constructor(private context: vscode.ExtensionContext) {
        this.outputChannel = vscode.window.createOutputChannel('Quickspaces');
        context.subscriptions.push(this.outputChannel);
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
        const providerId = cp.provider ?? 'github';
        const provider = this.getProviderInfo(providerId, cp);
        const authProviderId = provider?.id ?? providerId;
        const scopes = this.getProviderScopes(provider);

        try {
            const session = await vscode.authentication.getSession(authProviderId, scopes, { createIfNone });
            return session?.accessToken;
        } catch {
            return undefined;
        }
    }

    private getProviderScopes(provider?: ProviderInfo): string[] {
        if (!provider || !provider.scope) {
            return [];
        }
        return provider.scope.split(/[\s,]+/).filter(Boolean);
    }

    private getControlPlaneCacheKey(cp: ControlPlane): string {
        return trimTrailingSlashes(cp.url);
    }

    private async getAvailableProviders(controlPlaneOrUrl?: ControlPlane | string, token?: string): Promise<ProviderInfo[]> {
        const controlPlaneUrl = typeof controlPlaneOrUrl === 'string'
            ? controlPlaneOrUrl
            : controlPlaneOrUrl?.url;

        if (controlPlaneUrl) {
            const normalizedUrl = trimTrailingSlashes(controlPlaneUrl);
            const cached = this.providerCacheByControlPlaneUrl.get(normalizedUrl);
            if (cached) {
                return cached;
            }

            const providers = await this.fetchProvidersFromControlPlane(normalizedUrl, token);
            const mergedProviders = providers.length
                ? this.mergeProviderLists(DEFAULT_REPO_PROVIDERS, providers)
                : DEFAULT_REPO_PROVIDERS;

            this.providerCacheByControlPlaneUrl.set(normalizedUrl, mergedProviders);
            return mergedProviders;
        }

        return DEFAULT_REPO_PROVIDERS;
    }

    private async fetchProvidersFromControlPlane(controlPlaneUrl: string, token?: string): Promise<ProviderInfo[]> {
        const candidatePaths = [
            '/api/v1/repo-providers',
            '/api/v1/providers',
        ];

        for (const path of candidatePaths) {
            const requestUrl = `${trimTrailingSlashes(controlPlaneUrl)}${path}`;
            this.logDebug(`Fetching providers from ${requestUrl}`);
            try {
                const response = await httpGetJson<unknown>(requestUrl, token ? {
                    headers: { Authorization: `Bearer ${token}` },
                } : undefined);
                const providers = this.normalizeProviderList(response);
                this.logDebug(`Provider response length: ${Array.isArray(response) ? response.length : 0}`);
                if (providers.length) {
                    this.logDebug(`Found ${providers.length} providers from ${requestUrl}`);
                    return providers;
                }
                this.logDebug(`No providers found at ${requestUrl}`);
            } catch (error) {
                this.logError(`Unable to fetch providers from ${requestUrl}: ${error instanceof Error ? error.message : String(error)}`);
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
                if (typeof provider.slug !== 'string' || typeof provider.name !== 'string') {
                    return undefined;
                }

                const scope = Array.isArray(provider.scope)
                    ? provider.scope.filter((value: unknown): value is string => typeof value === 'string').join(' ')
                    : typeof provider.scope === 'string'
                        ? provider.scope
                        : undefined;

                return {
                    id: provider.slug.toLowerCase(),
                    label: provider.name,
                    apiUrl: typeof provider.apiUrl === 'string' ? provider.apiUrl : undefined,
                    repositoryUrlTemplate: typeof provider.repositoryUrlTemplate === 'string'
                        ? provider.repositoryUrlTemplate
                        : undefined,
                    authorizationUrl: typeof provider.authorizationUrl === 'string'
                        ? provider.authorizationUrl
                        : undefined,
                    tokenUrl: typeof provider.tokenUrl === 'string' ? provider.tokenUrl : undefined,
                    scope,
                    repoListUrl: typeof provider.repoListUrl === 'string' ? provider.repoListUrl : undefined,
                    repoListPath: typeof provider.repoListPath === 'string' ? provider.repoListPath : undefined,
                    branchListUrl: typeof provider.branchListUrl === 'string' ? provider.branchListUrl : undefined,
                    branchListPath: typeof provider.branchListPath === 'string' ? provider.branchListPath : undefined,
                    branchCreateUrl: typeof provider.branchCreateUrl === 'string' ? provider.branchCreateUrl : undefined,
                    branchCreatePath: typeof provider.branchCreatePath === 'string' ? provider.branchCreatePath : undefined,
                    branchCreateBodyTemplate: typeof provider.branchCreateBodyTemplate === 'string' ? provider.branchCreateBodyTemplate : undefined,
                    branchCreateMethod: typeof provider.branchCreateMethod === 'string' ? provider.branchCreateMethod : undefined,
                };
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

        return DEFAULT_REPO_PROVIDERS.find(provider => provider.id === providerId);
    }

    private mergeProviderLists(defaultProviders: ProviderInfo[], remoteProviders: ProviderInfo[]): ProviderInfo[] {
        const providerMap = new Map<string, ProviderInfo>();

        for (const provider of defaultProviders) {
            providerMap.set(provider.id, provider);
        }

        for (const provider of remoteProviders) {
            const existing = providerMap.get(provider.id);
            providerMap.set(provider.id, existing ? { ...existing, ...provider } : provider);
        }

        return Array.from(providerMap.values());
    }

    private hasBranchCreateConfig(provider?: ProviderInfo): boolean {
        return Boolean(provider?.branchCreateUrl || provider?.branchCreatePath);
    }

    private getProviderBranchUrl(provider: ProviderInfo | undefined, controlPlane: ControlPlane, workspace: WorkspaceInfo): string | undefined {
        if (!provider) {
            return undefined;
        }

        const baseUrl = provider.apiUrl || controlPlane.providerApiUrl;
        if (!baseUrl) {
            return undefined;
        }

        if (provider.branchListUrl) {
            return this.applyTemplate(provider.branchListUrl, this.buildTemplateVariables(provider, workspace));
        }

        if (provider.branchListPath) {
            const path = this.applyTemplate(provider.branchListPath, this.buildTemplateVariables(provider, workspace));
            return `${trimTrailingSlashes(baseUrl)}/${trimLeadingSlashes(path)}`;
        }

        return undefined;
    }

    private getProviderBranchCreateRequest(
        provider: ProviderInfo | undefined,
        controlPlane: ControlPlane,
        workspace: WorkspaceInfo,
        newBranch: string,
        sourceBranch: string,
        token: string,
    ): { url: string; method: string; body?: string; headers: Record<string, string> } | undefined {
        if (!provider) {
            return undefined;
        }

        const baseUrl = provider.apiUrl || controlPlane.providerApiUrl;
        if (!baseUrl) {
            return undefined;
        }

        const variables = this.buildTemplateVariables(provider, workspace, newBranch, sourceBranch);
        let url: string | undefined;

        if (provider.branchCreateUrl) {
            url = this.applyTemplate(provider.branchCreateUrl, variables);
        } else if (provider.branchCreatePath) {
            const path = this.applyTemplate(provider.branchCreatePath, variables);
            url = `${trimTrailingSlashes(baseUrl)}/${trimLeadingSlashes(path)}`;
        }

        if (!url) {
            return undefined;
        }

        const method = provider.branchCreateMethod?.toUpperCase() || 'POST';
        const body = provider.branchCreateBodyTemplate
            ? this.applyTemplate(provider.branchCreateBodyTemplate, variables)
            : JSON.stringify({ branch: newBranch, ref: sourceBranch });

        return {
            url,
            method,
            body,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
        };
    }

    private buildTemplateVariables(
        provider: ProviderInfo,
        workspace: WorkspaceInfo,
        newBranch?: string,
        sourceBranch?: string,
    ): Record<string, string | undefined> {
        const repoPath = workspace.repo_owner && workspace.repo_name ? `${workspace.repo_owner}/${workspace.repo_name}` : undefined;
        return {
            providerId: provider.id,
            provider: provider.id,
            repo_owner: workspace.repo_owner,
            repo_name: workspace.repo_name,
            repoOwner: workspace.repo_owner,
            repoName: workspace.repo_name,
            repo_path: repoPath,
            repoPath: repoPath,
            branch: sourceBranch,
            ref: sourceBranch,
            sourceBranch,
            source_branch: sourceBranch,
            newBranch,
            new_branch: newBranch,
        };
    }

    private applyTemplate(template: string, values: Record<string, string | undefined>): string {
        return template.replace(/\{(\w+)\}/g, (_match, key) => {
            const value = values[key];
            return typeof value === 'string' ? value : '';
        });
    }

    private controlPlaneDescription(): string {
        const count = this.controlPlanes.length;
        return count ? `${count} control plane${count === 1 ? '' : 's'}` : '';
    }

    private showOutputChannelIfNeeded(): void {
        if (!this.hasShownOutputChannel) {
            this.outputChannel.show(true);
            this.hasShownOutputChannel = true;
        }
    }

    private logDebug(message: string): void {
        const formatted = `[Quickspaces] ${message}`;
        console.debug(formatted);
        this.outputChannel.appendLine(formatted);
        this.showOutputChannelIfNeeded();
    }

    private logError(message: string): void {
        const formatted = `[Quickspaces] ERROR: ${message}`;
        console.error(formatted);
        this.outputChannel.appendLine(formatted);
        this.showOutputChannelIfNeeded();
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

    async configureWorkspace(workspaceOrItem: WorkspaceInfo | WorkspaceItem | vscode.TreeItem | undefined): Promise<void> {
        const resolved = this.resolveWorkspace(workspaceOrItem);
        if (!resolved) {
            return;
        }

        const { workspace, controlPlane } = resolved;
        if (!controlPlane) {
            vscode.window.showErrorMessage('Unable to determine the control plane for this workspace');
            return;
        }

        const workspaceId = workspace.workspace_id ?? workspace.workspaceId;
        if (!workspaceId) {
            vscode.window.showErrorMessage('Selected workspace cannot be configured because it has no workspace ID');
            return;
        }

        const action = await vscode.window.showQuickPick([
            { label: 'Change branch/ref', description: 'Update the repository reference for this workspace' },
            { label: 'Set desired state', description: 'Update the desired workspace state' },
            { label: 'Edit labels', description: 'Update workspace labels' },
            { label: 'Set TTL policy', description: 'Update the workspace TTL policy' },
            { label: 'Delete workspace', description: 'Remove this workspace from the control plane' },
        ], {
            placeHolder: 'Choose a workspace configuration action',
        });

        if (!action) {
            return;
        }

        const providerToken = await this.getAccessToken(controlPlane, true);
        if (!providerToken) {
            vscode.window.showWarningMessage('Sign in to authenticate with the configured repository provider.');
            return;
        }

        if (action.label === 'Delete workspace') {
            const confirm = await vscode.window.showWarningMessage(
                `Delete workspace ${workspaceId}? This action cannot be undone.`,
                { modal: true },
                'Delete',
            );
            if (confirm !== 'Delete') {
                return;
            }

            const deleteUrl = `${trimTrailingSlashes(controlPlane.url)}/api/v1/workspaces/${workspaceId}`;
            try {
                await httpRequestJson<void>(deleteUrl, 'DELETE', undefined, {
                    headers: {
                        Authorization: `Bearer ${providerToken}`,
                    },
                });
                this.workspaceCacheByControlPlaneUrl.delete(this.getControlPlaneCacheKey(controlPlane));
                this.refresh();
                vscode.window.showInformationMessage(`Workspace ${workspaceId} deleted successfully`);
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unable to delete workspace.';
                vscode.window.showErrorMessage(`Failed to delete workspace: ${message}`);
            }
            return;
        }

        const requestBody: Partial<CreateWorkspaceRequest> = {};

        if (action.label === 'Change branch/ref') {
            const ref = await vscode.window.showInputBox({
                prompt: 'Enter branch, tag, or commit reference for the workspace',
                value: workspace.ref || 'main',
            });
            if (!ref) {
                return;
            }
            requestBody.ref = ref;
        }

        if (action.label === 'Set desired state') {
            const desiredState = await vscode.window.showQuickPick([
                { label: 'started' },
                { label: 'stopped' },
            ], {
                placeHolder: 'Select the desired state for the workspace',
            });
            if (!desiredState) {
                return;
            }
            requestBody.desiredState = desiredState.label;
        }

        if (action.label === 'Edit labels') {
            const existingLabels = workspace.labels && typeof workspace.labels === 'object'
                ? Object.entries(workspace.labels).map(([key, value]) => `${key}=${value}`).join(', ')
                : '';
            const labelInput = await vscode.window.showInputBox({
                prompt: 'Enter labels as comma-separated key=value pairs',
                placeHolder: 'env=dev,team=backend',
                value: existingLabels,
            });
            if (labelInput === undefined) {
                return;
            }

            if (!labelInput.trim()) {
                requestBody.labels = {};
            } else {
                const labels: Record<string, string> = {};
                for (const pair of labelInput.split(',')) {
                    const trimmedPair = pair.trim();
                    if (!trimmedPair) {
                        continue;
                    }
                    const [key, ...valueParts] = trimmedPair.split('=');
                    if (!key) {
                        vscode.window.showErrorMessage('Labels must be in key=value format');
                        return;
                    }
                    labels[key.trim()] = valueParts.join('=').trim();
                }
                requestBody.labels = labels;
            }
        }

        if (action.label === 'Set TTL policy') {
            const ttlPolicy = await vscode.window.showInputBox({
                prompt: 'Enter TTL policy for this workspace',
                placeHolder: 'e.g. 1h, 24h, 7d',
                value: workspace.ttlPolicy ?? '',
            });
            if (ttlPolicy === undefined) {
                return;
            }
            requestBody.ttlPolicy = ttlPolicy.trim() || null;
        }

        if (!Object.keys(requestBody).length) {
            return;
        }

        const url = `${trimTrailingSlashes(controlPlane.url)}/api/v1/workspaces/${workspaceId}`;

        try {
            await httpRequestJson<void>(url, 'PATCH', JSON.stringify(requestBody), {
                headers: {
                    Authorization: `Bearer ${providerToken}`,
                    'Content-Type': 'application/json',
                },
            });
            this.workspaceCacheByControlPlaneUrl.delete(this.getControlPlaneCacheKey(controlPlane));
            this.refresh();
            vscode.window.showInformationMessage(`Workspace ${workspaceId} configured successfully`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to configure workspace.';
            vscode.window.showErrorMessage(`Failed to configure workspace: ${message}`);
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

        const providerToken = await this.getAccessToken(controlPlane, true);
        const providers = await this.getAvailableProviders(controlPlane, providerToken);
        if (!providers.length) {
            if (!providerToken) {
                vscode.window.showWarningMessage('Sign in to authenticate with the configured control plane.');
                return;
            }
            vscode.window.showErrorMessage('No repository providers are configured for this control plane.');
            return;
        }

        let selectedProvider: ProviderInfo | undefined;
        const providerId = controlPlane.provider?.toLowerCase();
        if (providerId) {
            selectedProvider = providers.find(p => p.id === providerId);
        }

        if (providers.length === 1) {
            selectedProvider = providers[0];
        }

        if (!selectedProvider || providers.length > 1) {
            const providerPick = await vscode.window.showQuickPick(
                providers.map(provider => ({
                    label: provider.label,
                    description: provider.apiUrl,
                    provider,
                    picked: provider.id === providerId,
                } as vscode.QuickPickItem & { provider: ProviderInfo })),
                {
                    placeHolder: 'Select a repository provider',
                },
            );

            if (!providerPick) {
                return;
            }

            selectedProvider = providerPick.provider;
        }

        const currentControlPlaneName = controlPlane.name;
        const currentControlPlaneUrl = controlPlane.url;
        this.logDebug(`Selected provider ${selectedProvider?.id} for control plane ${currentControlPlaneName}`);
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

        if (!providerToken) {
            vscode.window.showWarningMessage('Sign in to authenticate with the selected repository provider.');
            return;
        }

        const repos = await this.listRepos(controlPlane, providerToken);
        if (!repos.length) {
            vscode.window.showInformationMessage('No repositories were found after login.');
            return;
        }

        const quickPickItems = repos.map(repo => ({
            label: repo.repo_owner && repo.repo_name ? `${repo.repo_owner}/${repo.repo_name}` : repo.workspace_id ?? repo.ref ?? 'Repository',
            description: repo.actual_state || repo.desired_state || '',
            detail: repo.connection_url || repo.ref || '',
            workspace: repo,
        } as vscode.QuickPickItem & { workspace: WorkspaceInfo }));

        const ownedItems = quickPickItems;

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

        const provider = this.getProviderInfo(controlPlane.provider ?? '', controlPlane);
        const branchNames = await this.listRepoBranches(controlPlane, selectedWorkspace, providerToken);
        const canCreateBranch = this.hasBranchCreateConfig(provider);
        let selectedRef: string | undefined;

        if (branchNames.length) {
            const branchPickItems: Array<vscode.QuickPickItem & { branch?: string; createBranch?: true }> = [
                ...branchNames.map(branch => ({ label: branch, branch })),
            ];

            if (canCreateBranch) {
                branchPickItems.unshift({
                    label: '$(plus) Create new branch...',
                    description: 'Create a new branch for this repository',
                    createBranch: true,
                });
            }

            const branchPick = await vscode.window.showQuickPick(branchPickItems, {
                placeHolder: 'Select an existing branch or create a new one',
            });

            if (!branchPick) {
                return;
            }

            if (branchPick.createBranch) {
                const newBranch = await vscode.window.showInputBox({
                    prompt: 'Enter the new branch name',
                    placeHolder: 'feature/my-new-branch',
                });
                if (!newBranch) {
                    return;
                }

                const baseBranch = await vscode.window.showQuickPick(branchNames, {
                    placeHolder: 'Select the base branch for the new branch',
                });
                if (!baseBranch) {
                    return;
                }

                const created = await this.createRepoBranch(controlPlane, provider, selectedWorkspace, newBranch, baseBranch, providerToken);
                if (!created) {
                    vscode.window.showErrorMessage('Unable to create the new branch.');
                    return;
                }
                selectedRef = newBranch;
            } else {
                selectedRef = branchPick.branch;
            }
        } else {
            selectedRef = await vscode.window.showInputBox({
                prompt: 'Enter branch, tag, or commit reference for the workspace',
                placeHolder: 'main',
                value: selectedWorkspace.ref || 'main',
            });
        }

        if (!selectedRef) {
            return;
        }

        const workspaceRequest: CreateWorkspaceRequest = {
            repoOwner: selectedWorkspace.repo_owner,
            repoName: selectedWorkspace.repo_name,
            repoProvider: selectedProvider?.id ?? controlPlane.provider ?? '',
            ref: selectedRef,
        };

        const createUrl = `${trimTrailingSlashes(controlPlane.url)}/api/v1/workspaces`;

        try {
            await this.createWorkspace(createUrl, workspaceRequest, controlPlane, providerToken);
            this.workspaceCacheByControlPlaneUrl.delete(this.getControlPlaneCacheKey(controlPlane));
            this.refresh();
            vscode.window.showInformationMessage(`Workspace created for ${selectedWorkspace.repo_owner}/${selectedWorkspace.repo_name}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to create workspace.';
            vscode.window.showErrorMessage(`Failed to create workspace: ${message}`);
        }
    }

    private async listRepos(controlPlane: ControlPlane, token: string, allowRetry = true): Promise<WorkspaceInfo[]> {
        const repoUrl = this.getProviderRepoUrl(controlPlane);
        if (!repoUrl) {
            vscode.window.showErrorMessage('Repository provider is missing repoListUrl or repoListPath configuration.');
            return [];
        }

        this.logDebug(`Listing repos from ${repoUrl} using provider ${controlPlane.provider}`);
        try {
            const repos = await httpGetJson<unknown>(repoUrl, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const normalized = this.normalizeProviderRepos(repos);
            this.logDebug(`Repository response normalized to ${normalized.length} items from ${repoUrl}`);
            if (normalized.length > 0) {
                return normalized;
            }
            this.logDebug(`No repositories found at ${repoUrl}; falling back to control plane workspace list`);
        } catch (error) {
            this.logError(`Failed to list repos from ${repoUrl}: ${error instanceof Error ? error.message : String(error)}`);
            if (allowRetry && error instanceof Error && /HTTP\s+401/i.test(error.message)) {
                const refreshedToken = await this.getAccessToken(controlPlane, true);
                if (refreshedToken && refreshedToken !== token) {
                    return await this.listRepos(controlPlane, refreshedToken, false);
                }
            }
        }

        const fallbackUrl = `${trimTrailingSlashes(controlPlane.url)}/api/v1/workspaces`;
        this.logDebug(`Trying fallback workspace list at ${fallbackUrl}`);
        try {
            const workspaces = await httpGetJson<WorkspaceInfo[]>(fallbackUrl, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const count = Array.isArray(workspaces) ? workspaces.length : 0;
            this.logDebug(`Fallback workspace list returned ${count} items`);
            return Array.isArray(workspaces) ? workspaces : [];
        } catch (error) {
            this.logError(`Failed fallback workspace list from ${fallbackUrl}: ${error instanceof Error ? error.message : String(error)}`);
            if (error instanceof Error && /HTTP\s+401/i.test(error.message)) {
                const refreshedToken = await this.getAccessToken(controlPlane, true);
                if (refreshedToken && refreshedToken !== token) {
                    return await this.listRepos(controlPlane, refreshedToken, false);
                }
            }
            return [];
        }
    }

    private async listRepoBranches(controlPlane: ControlPlane, workspace: WorkspaceInfo, token: string): Promise<string[]> {
        if (!workspace.repo_owner || !workspace.repo_name) {
            return [];
        }

        const provider = this.getProviderInfo(controlPlane.provider ?? '', controlPlane);
        const branchUrl = this.getProviderBranchUrl(provider, controlPlane, workspace);
        if (!branchUrl) {
            return [];
        }

        try {
            const branches = await httpGetJson<unknown>(branchUrl, {
                headers: { Authorization: `Bearer ${token}` },
            });
            return this.normalizeBranchList(branches);
        } catch (error) {
            this.logError(`Failed to list branches from ${branchUrl}: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    private normalizeBranchList(branches: unknown): string[] {
        if (!Array.isArray(branches)) {
            return [];
        }

        return branches
            .map(item => {
                if (!item || typeof item !== 'object') {
                    return undefined;
                }

                const branch = item as any;
                return typeof branch.name === 'string' ? branch.name : undefined;
            })
            .filter((branch): branch is string => Boolean(branch));
    }

    private async createRepoBranch(
        controlPlane: ControlPlane,
        provider: ProviderInfo | undefined,
        workspace: WorkspaceInfo,
        newBranch: string,
        sourceBranch: string,
        token: string,
    ): Promise<boolean> {
        if (!workspace.repo_owner || !workspace.repo_name) {
            return false;
        }

        const request = this.getProviderBranchCreateRequest(provider, controlPlane, workspace, newBranch, sourceBranch, token);
        if (!request) {
            return false;
        }

        try {
            await httpRequestJson<void>(request.url, request.method, request.body ?? undefined, {
                headers: request.headers,
            });
            return true;
        } catch (error) {
            this.logError(`Failed to create branch ${newBranch}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
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
        this.logDebug(`Resolving repo URL for provider ${providerId} using control plane ${cp.url}`);
        this.logDebug(`Provider info: ${provider ? JSON.stringify(provider) : 'none'}`);
        if (provider?.repoListUrl) {
            if (this.isAbsoluteUrl(provider.repoListUrl)) {
                this.logDebug(`Using absolute repoListUrl: ${provider.repoListUrl}`);
                return provider.repoListUrl;
            }

            const baseUrl = provider?.apiUrl || cp.providerApiUrl || this.getProviderBaseUrl(providerId);
            if (!baseUrl) {
                this.logError(`Provider ${providerId ?? 'unknown'} is missing apiUrl, repoListUrl, and repoListPath configuration`);
                return '';
            }

            const normalized = trimTrailingSlashes(baseUrl);
            const resolved = `${normalized}${provider.repoListUrl.startsWith('/') ? '' : '/'}${provider.repoListUrl}`;
            this.logDebug(`Resolved repoListUrl to ${resolved}`);
            return resolved;
        }

        const baseUrl = provider?.apiUrl || cp.providerApiUrl || this.getProviderBaseUrl(providerId);
        if (!baseUrl) {
            this.logError(`Provider ${providerId ?? 'unknown'} is missing apiUrl, repoListUrl, and repoListPath configuration`);
            return '';
        }

        const normalized = trimTrailingSlashes(baseUrl);

        if (provider?.repoListPath) {
            const resolved = `${normalized}${provider.repoListPath.startsWith('/') ? '' : '/'}${provider.repoListPath}`;
            this.logDebug(`Resolved repoListPath to ${resolved}`);
            return resolved;
        }

        if (provider?.repoListUrl) {
            if (this.isAbsoluteUrl(provider.repoListUrl)) {
                this.logDebug(`Using absolute repoListUrl: ${provider.repoListUrl}`);
                return provider.repoListUrl;
            }
            const resolved = `${normalized}${provider.repoListUrl.startsWith('/') ? '' : '/'}${provider.repoListUrl}`;
            this.logDebug(`Resolved repoListUrl to ${resolved}`);
            return resolved;
        }

        this.logError(`Provider ${providerId ?? 'unknown'} is missing repoListUrl or repoListPath configuration`);
        return '';
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

    private isAbsoluteUrl(url: string): boolean {
        return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
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

    private normalizeWorkspaces(workspaces: WorkspaceInfo[]): WorkspaceInfo[] {
        return workspaces.map(item => {
            const workspace = { ...item };
            if (!workspace.workspace_id && workspace.workspaceId) {
                workspace.workspace_id = workspace.workspaceId;
            }
            if (!workspace.workspaceId && workspace.workspace_id) {
                workspace.workspaceId = workspace.workspace_id;
            }

            if (!workspace.repo_owner && workspace.repoName) {
                workspace.repo_owner = workspace.repoName;
            }
            if (!workspace.repoName && workspace.repo_owner) {
                workspace.repoName = workspace.repo_owner;
            }

            if (!workspace.repo_name && workspace.repoName) {
                workspace.repo_name = workspace.repoName;
            }
            if (!workspace.repoName && workspace.repo_name) {
                workspace.repoName = workspace.repo_name;
            }

            if (!workspace.actual_state && workspace.actualState) {
                workspace.actual_state = workspace.actualState;
            }
            if (!workspace.actualState && workspace.actual_state) {
                workspace.actualState = workspace.actual_state;
            }

            if (!workspace.desired_state && workspace.desiredState) {
                workspace.desired_state = workspace.desiredState;
            }
            if (!workspace.desiredState && workspace.desired_state) {
                workspace.desiredState = workspace.desired_state;
            }

            if (!workspace.connection_url && workspace.connectionUrl) {
                workspace.connection_url = workspace.connectionUrl;
            }
            if (!workspace.connectionUrl && workspace.connection_url) {
                workspace.connectionUrl = workspace.connection_url;
            }

            return workspace;
        });
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

    private resolveWorkspace(workspaceOrItem: WorkspaceInfo | WorkspaceItem | vscode.TreeItem | undefined): { workspace: WorkspaceInfo; controlPlane?: ControlPlane } | undefined {
        if (!workspaceOrItem) {
            return undefined;
        }

        if (workspaceOrItem instanceof WorkspaceItem) {
            const controlPlane = this.controlPlanes.find(cp => cp.name === workspaceOrItem.controlPlaneName);
            return { workspace: workspaceOrItem.workspace, controlPlane };
        }

        const treeItem = workspaceOrItem as vscode.TreeItem & { workspace?: WorkspaceInfo; controlPlaneName?: string };
        if (treeItem.workspace) {
            const controlPlane = treeItem.controlPlaneName
                ? this.controlPlanes.find(cp => cp.name === treeItem.controlPlaneName)
                : undefined;
            return { workspace: treeItem.workspace, controlPlane };
        }

        const possible = workspaceOrItem as WorkspaceInfo;
        if (possible.workspace_id || possible.workspaceId || possible.repo_owner || possible.repo_name) {
            return { workspace: possible };
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
            return [new StatusItem('Authorization required', 'Authorize the repository provider to access this control plane', 'warning')];
        }

        const url = `${trimTrailingSlashes(cp.url)}/api/v1/workspaces`;
        try {
            const workspaces = await httpGetJson<WorkspaceInfo[]>(url, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const normalized = this.normalizeWorkspaces(Array.isArray(workspaces) ? workspaces : []);
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
                    const normalized = this.normalizeWorkspaces(Array.isArray(workspaces) ? workspaces : []);
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

export { httpGetJson, httpPostJson, httpRequestJson };
export { ControlPlaneItem, WorkspaceItem, StatusItem } from './treeItems';
