import * as vscode from 'vscode';
import { ControlPlane, ProviderInfo, WorkspaceInfo, CreateWorkspaceRequest, UpdateWorkspaceRequest } from './types';
import { ControlPlaneItem, WorkspaceItem, StatusItem } from './treeItems';
import { DEFAULT_REPO_PROVIDERS } from './repoProviders';
import { trimLeadingSlashes, trimTrailingSlashes } from './utils';
import { httpGetJson, httpPostJson, httpRequestJson } from './http';

type TreeItem = ControlPlaneItem | WorkspaceItem | StatusItem;

const EXECUTION_PROFILES = [
    {
        label: 'Small',
        description: 'Light execution profile',
        adapter_type: 'container',
        runtime_config: { profile: 'small' },
    },
    {
        label: 'Medium',
        description: 'Balanced execution profile',
        adapter_type: 'container',
        runtime_config: { profile: 'medium' },
    },
    {
        label: 'Large',
        description: 'High-capacity execution profile',
        adapter_type: 'container',
        runtime_config: { profile: 'large' },
    },
] as const;

type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];

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
        const normalizedId = providerId?.toLowerCase();
        if (normalizedId) {
            if (cp?.url) {
                const normalizedUrl = trimTrailingSlashes(cp.url);
                const providers = this.providerCacheByControlPlaneUrl.get(normalizedUrl);
                const match = providers?.find(p => p.id === normalizedId);
                if (match) {
                    return match;
                }
            }

            for (const providers of this.providerCacheByControlPlaneUrl.values()) {
                const match = providers.find(p => p.id === normalizedId);
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
        const repoInfo = getWorkspaceRepo(workspace);
        const repoOwner = repoInfo?.owner;
        const repoName = repoInfo?.repo;
        const repoPath = repoOwner && repoName ? `${repoOwner}/${repoName}` : undefined;
        return {
            providerId: provider.id,
            provider: provider.id,
            repo_owner: repoOwner,
            repo_name: repoName,
            repoOwner,
            repoName,
            repo_path: repoPath,
            repoPath: repoPath,
            repo_path_escaped: repoPath ? encodeURIComponent(repoPath) : undefined,
            repoPathEscaped: repoPath ? encodeURIComponent(repoPath) : undefined,
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

        if (!(await this.validateControlPlaneUrl(url))) {
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
                {
                    placeHolder: 'Select a repository provider for this control plane (optional)',
                    ignoreFocusOut: false,
                },
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
            ignoreFocusOut: false,
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
            if (!(await this.validateControlPlaneUrl(newUrl))) {
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

        const workspace = this.normalizeWorkspace(resolved.workspace);
        const { controlPlane } = resolved;
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

            const apiClient = createControlPlaneApiClient(controlPlane, providerToken);
            try {
                await apiClient.deleteWorkspace(workspaceId);
                this.workspaceCacheByControlPlaneUrl.delete(this.getControlPlaneCacheKey(controlPlane));
                this.refresh();
                vscode.window.showInformationMessage(`Workspace ${workspaceId} deleted successfully`);
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unable to delete workspace.';
                vscode.window.showErrorMessage(`Failed to delete workspace: ${message}`);
            }
            return;
        }

        const requestBody: Partial<UpdateWorkspaceRequest> = {};

        if (action.label === 'Change branch/ref') {
            let ref: string | undefined;
            const providerId = controlPlane.provider ?? workspace.source?.config?.provider;
            const provider = this.getProviderInfo(providerId ?? '', controlPlane);
            const branchNames = await this.listRepoBranches(controlPlane, workspace, providerToken);
            if (branchNames.length > 0) {
                const branchPick = await vscode.window.showQuickPick(
                    branchNames.map(branch => ({ label: branch })),
                    {
                        placeHolder: 'Select the branch, tag, or commit reference for the workspace',
                        ignoreFocusOut: false,
                    },
                );
                if (branchPick) {
                    ref = branchPick.label;
                }
            }

            if (!ref) {
                ref = await vscode.window.showInputBox({
                    prompt: 'Enter branch, tag, or commit reference for the workspace',
                    value: workspace.ref || 'main',
                });
            }

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
                ignoreFocusOut: false,
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

        const updateRequestBody = this.buildWorkspacePatchRequest(workspace, controlPlane, requestBody);
        const apiClient = createControlPlaneApiClient(controlPlane, providerToken);

        try {
            await apiClient.updateWorkspace(workspaceId, updateRequestBody);
            this.workspaceCacheByControlPlaneUrl.delete(this.getControlPlaneCacheKey(controlPlane));
            this.refresh();
            vscode.window.showInformationMessage(`Workspace ${workspaceId} configured successfully`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to configure workspace.';
            vscode.window.showErrorMessage(`Failed to configure workspace: ${message}`);
        }
    }

    async connectWorkspace(workspaceOrItem: WorkspaceInfo | WorkspaceItem | vscode.TreeItem | undefined): Promise<void> {
        const resolved = this.resolveWorkspace(workspaceOrItem);
        if (!resolved) {
            vscode.window.showErrorMessage('Unable to determine the selected workspace.');
            return;
        }

        const workspace = this.normalizeWorkspace(resolved.workspace);
        const connectionUrl = workspace.connection_url ?? workspace.connectionUrl;
        if (!connectionUrl) {
            vscode.window.showErrorMessage('Unable to connect to the workspace because it has no connection URL.');
            return;
        }

        const actualState = (workspace.actual_state ?? workspace.actualState)?.toString().toLowerCase();
        const desiredState = (workspace.desired_state ?? workspace.desiredState)?.toString().toLowerCase();
        const isRunning = actualState === 'running';

        if (!isRunning && desiredState !== 'running') {
            const controlPlane = resolved.controlPlane;
            if (!controlPlane) {
                vscode.window.showErrorMessage('Unable to determine the control plane for this workspace.');
                return;
            }

            const workspaceId = workspace.workspace_id ?? workspace.workspaceId;
            if (!workspaceId) {
                vscode.window.showErrorMessage('Unable to update workspace state because the workspace has no workspace ID.');
                return;
            }

            const providerToken = await this.getAccessToken(controlPlane, true);
            if (!providerToken) {
                vscode.window.showWarningMessage('Sign in to authenticate with the configured repository provider.');
                return;
            }

            const apiClient = createControlPlaneApiClient(controlPlane, providerToken);
            const patchRequest = this.buildWorkspacePatchRequest(workspace, controlPlane, { desiredState: 'running' });

            try {
                await apiClient.updateWorkspace(workspaceId, patchRequest);
                this.workspaceCacheByControlPlaneUrl.delete(this.getControlPlaneCacheKey(controlPlane));
                this.refresh();
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unable to update workspace desired state.';
                vscode.window.showErrorMessage(`Failed to start workspace: ${message}`);
                return;
            }
        }

        try {
            await vscode.env.openExternal(vscode.Uri.parse(connectionUrl));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to open the workspace connection URL.';
            vscode.window.showErrorMessage(`Failed to connect to workspace: ${message}`);
        }
    }

    async deleteWorkspace(workspaceOrItem: WorkspaceInfo | WorkspaceItem | vscode.TreeItem | undefined): Promise<void> {
        const resolved = this.resolveWorkspace(workspaceOrItem);
        if (!resolved) {
            vscode.window.showErrorMessage('Unable to determine the selected workspace.');
            return;
        }

        const workspace = this.normalizeWorkspace(resolved.workspace);
        const { controlPlane } = resolved;
        if (!controlPlane) {
            vscode.window.showErrorMessage('Unable to determine the control plane for this workspace.');
            return;
        }

        const workspaceId = workspace.workspace_id ?? workspace.workspaceId;
        if (!workspaceId) {
            vscode.window.showErrorMessage('Selected workspace cannot be deleted because it has no workspace ID.');
            return;
        }

        const providerToken = await this.getAccessToken(controlPlane, true);
        if (!providerToken) {
            vscode.window.showWarningMessage('Sign in to authenticate with the configured repository provider.');
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Delete workspace ${workspaceId}? This action cannot be undone.`,
            { modal: true },
            'Delete',
        );
        if (confirm !== 'Delete') {
            return;
        }

        const apiClient = createControlPlaneApiClient(controlPlane, providerToken);
        try {
            await apiClient.deleteWorkspace(workspaceId);
            this.workspaceCacheByControlPlaneUrl.delete(this.getControlPlaneCacheKey(controlPlane));
            this.refresh();
            vscode.window.showInformationMessage(`Workspace ${workspaceId} deleted successfully`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to delete workspace.';
            vscode.window.showErrorMessage(`Failed to delete workspace: ${message}`);
        }
    }

    private buildWorkspacePatchRequest(
        workspace: WorkspaceInfo,
        controlPlane: ControlPlane,
        requestBody: Partial<UpdateWorkspaceRequest>,
    ): Record<string, unknown> {
        const repoInfo = getWorkspaceRepo(workspace);
        return {
            ...requestBody,
            repoOwner: repoInfo?.owner ?? '',
            repoName: repoInfo?.repo ?? '',
            repoProvider: workspace.source?.config?.provider ?? controlPlane.provider ?? 'github',
            ref: requestBody.ref ?? workspace.ref ?? workspace.source?.config?.ref ?? 'main',
        };
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

        if (!providers.length) {
            vscode.window.showErrorMessage('No repository providers are configured for this control plane.');
            return;
        }

        const providerPick = await this.pickRepositorySource(providers, selectedProvider?.id);
        if (!providerPick) {
            return;
        }

        selectedProvider = providerPick;

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

        const ownedItems = quickPickItems.filter(item => this.isRepoOwnedByCurrentUser(item.workspace, currentUser));

        const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { workspace: WorkspaceInfo }>();
        quickPick.ignoreFocusOut = false;
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
        const selectedRepoInfo = getWorkspaceRepo(selectedWorkspace);
        if (!selectedRepoInfo) {
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
                ignoreFocusOut: false,
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
                    ignoreFocusOut: false,
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

        const selectedProfile = await this.promptForExecutionProfile();
        if (!selectedProfile) {
            return;
        }

        const workspaceRequest = this.buildCreateWorkspaceRequest(selectedProfile, selectedWorkspace, selectedRef, controlPlane);

        const apiClient = createControlPlaneApiClient(controlPlane, providerToken);

        try {
            await apiClient.createWorkspace(workspaceRequest);
            this.workspaceCacheByControlPlaneUrl.delete(this.getControlPlaneCacheKey(controlPlane));
            this.refresh();
            const selectedRepoInfo = getWorkspaceRepo(selectedWorkspace);
            vscode.window.showInformationMessage(`Workspace created for ${selectedRepoInfo?.owner}/${selectedRepoInfo?.repo}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unable to create workspace.';
            vscode.window.showErrorMessage(`Failed to create workspace: ${message}`);
        }
    }

    private async listRepos(controlPlane: ControlPlane, token: string): Promise<WorkspaceInfo[]> {
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
            return [];
        }
    }

    private async getProviderUserInfo(controlPlane: ControlPlane, token: string): Promise<{ login?: string; username?: string } | undefined> {
        const provider = this.getProviderInfo(controlPlane.provider ?? '', controlPlane);
        if (!provider?.apiUrl) {
            return undefined;
        }

        const normalized = provider.apiUrl.replace(/\/+$|\s+/g, '');
        const userUrl = `${normalized}/user`;

        try {
            const userData = await httpGetJson<unknown>(userUrl, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (userData && typeof userData === 'object') {
                const profile = userData as any;
                return {
                    login: typeof profile.login === 'string' ? profile.login : undefined,
                    username: typeof profile.username === 'string' ? profile.username : undefined,
                };
            }
        } catch (error) {
            this.logError(`Failed to fetch provider user info from ${userUrl}: ${error instanceof Error ? error.message : String(error)}`);
        }

        return undefined;
    }

    private isRepoOwnedByCurrentUser(repo: WorkspaceInfo, currentUser: { login?: string; username?: string } | undefined): boolean {
        const repoInfo = getWorkspaceRepo(repo);
        if (!currentUser || !repoInfo) {
            return false;
        }

        const owner = repoInfo.owner.toLowerCase();
        return [currentUser.login, currentUser.username].some(identity =>
            typeof identity === 'string' && identity.toLowerCase() === owner,
        );
    }

    private async getProviderUserInfo(controlPlane: ControlPlane, token: string): Promise<{ login?: string; username?: string } | undefined> {
        const provider = this.getProviderInfo(controlPlane.provider ?? '', controlPlane);
        if (!provider?.apiUrl) {
            return undefined;
        }

        const normalized = provider.apiUrl.replace(/\/+$|\s+/g, '');
        const userUrl = `${normalized}/user`;

        try {
            const userData = await httpGetJson<unknown>(userUrl, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (userData && typeof userData === 'object') {
                const profile = userData as any;
                return {
                    login: typeof profile.login === 'string' ? profile.login : undefined,
                    username: typeof profile.username === 'string' ? profile.username : undefined,
                };
            }
        } catch (error) {
            this.logError(`Failed to fetch provider user info from ${userUrl}: ${error instanceof Error ? error.message : String(error)}`);
        }

        return undefined;
    }

    private isRepoOwnedByCurrentUser(repo: WorkspaceInfo, currentUser: { login?: string; username?: string } | undefined): boolean {
        if (!currentUser || !repo.repo_owner) {
            return false;
        }

        const owner = repo.repo_owner.toLowerCase();
        return [currentUser.login, currentUser.username].some(identity =>
            typeof identity === 'string' && identity.toLowerCase() === owner,
        );
    }

    private async listRepoBranches(controlPlane: ControlPlane, workspace: WorkspaceInfo, token: string): Promise<string[]> {
        workspace = this.normalizeWorkspace(workspace);
        const repoInfo = getWorkspaceRepo(workspace);
        if (!repoInfo) {
            return [];
        }

        const providerId = controlPlane.provider ?? workspace.source?.config?.provider;
        const provider = this.getProviderInfo(providerId ?? '', controlPlane);
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
        workspace = this.normalizeWorkspace(workspace);
        const repoInfo = getWorkspaceRepo(workspace);
        if (!repoInfo) {
            console.warn('[QuickSpaces] Cannot resolve repo for branch creation from workspace:', workspace);
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

    private buildCreateWorkspaceRequest(profile: ExecutionProfile, workspace: WorkspaceInfo, ref: string, controlPlane: ControlPlane): CreateWorkspaceRequest {
        const repoInfo = getWorkspaceRepo(this.normalizeWorkspace(workspace));
        return {
            repoOwner: repoInfo?.owner ?? '',
            repoName: repoInfo?.repo ?? '',
            repoProvider: workspace.source?.config?.provider ?? controlPlane.provider ?? 'github',
            ref,
            adapterType: profile.adapter_type,
            runtimeConfig: profile.runtime_config,
        };
    }

    private async promptForExecutionProfile(): Promise<ExecutionProfile | undefined> {
        const profilePickItems = EXECUTION_PROFILES.map(profile => ({
            label: profile.label,
            description: profile.description,
            profile,
        }));

        const selected = await vscode.window.showQuickPick(profilePickItems, {
            placeHolder: 'Select an execution profile',
            ignoreFocusOut: false,
        });

        return selected?.profile;
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

        return DEFAULT_REPO_PROVIDERS.find(provider => provider.id === providerId)?.apiUrl;
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
        return workspaces.map(item => this.normalizeWorkspace(item));
    }

    private normalizeWorkspace(item: WorkspaceInfo): WorkspaceInfo {
        const workspace = { ...item };
        if (!workspace.workspace_id && workspace.workspaceId) {
            workspace.workspace_id = workspace.workspaceId;
        }
        if (!workspace.workspaceId && workspace.workspace_id) {
            workspace.workspaceId = workspace.workspace_id;
        }

        if (workspace.source?.config?.owner) {
            workspace.repo_owner = workspace.source.config.owner;
            workspace.repoOwner = workspace.source.config.owner;
        } else if (!workspace.repo_owner && workspace.repoName) {
            workspace.repo_owner = workspace.repoName;
        }
        if (!workspace.repoName && workspace.repo_owner) {
            workspace.repoName = workspace.repo_owner;
        }

        if (workspace.source?.config?.repo) {
            workspace.repo_name = workspace.source.config.repo;
            workspace.repoName = workspace.source.config.repo;
        } else if (!workspace.repo_name && workspace.repoName) {
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

        if (!workspace.ref && workspace.source?.config?.ref) {
            workspace.ref = workspace.source.config.ref;
        }

        return workspace;
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
        if (
            possible.workspace_id ||
            possible.workspaceId ||
            possible.repo_owner ||
            possible.repo_name ||
            (possible.source?.config?.owner && possible.source?.config?.repo)
        ) {
            return { workspace: possible };
        }

        return undefined;
    }

    private async getWorkspaceChildren(cp: ControlPlane): Promise<TreeItem[]> {
        const cached = this.workspaceCacheByControlPlaneUrl.get(this.getControlPlaneCacheKey(cp));
        if (cached) {
            return cached.map(workspace => new WorkspaceItem(workspace, cp.name));
        }

        const token = await this.getAccessToken(cp, false);
        if (!token) {
            return [new StatusItem('Authorization required', 'Authorize the repository provider to access this control plane', 'warning')];
        }

        const apiClient = createControlPlaneApiClient(cp, token);
        try {
            const workspaces = await apiClient.listWorkspaces();
            const normalized = this.normalizeWorkspaces(Array.isArray(workspaces) ? workspaces : []);
            this.workspaceCacheByControlPlaneUrl.set(this.getControlPlaneCacheKey(cp), normalized);

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

export { httpGetJson, httpPostJson, httpRequestJson };
export { ControlPlaneItem, WorkspaceItem, StatusItem } from './treeItems';
