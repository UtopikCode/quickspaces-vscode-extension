export interface ControlPlane {
    name: string;
    url: string;
    provider?: string;
    providerApiUrl?: string;
}

export interface ProviderInfo {
    id: string;
    label: string;
    apiUrl?: string;
    repositoryUrlTemplate?: string;
    authorizationUrl?: string;
    tokenUrl?: string;
    scope?: string;
    repoListUrl?: string;
    repoListPath?: string;
    branchListUrl?: string;
    branchListPath?: string;
    branchCreateUrl?: string;
    branchCreatePath?: string;
    branchCreateBodyTemplate?: string;
    branchCreateMethod?: string;
}

export interface WorkspaceInfo {
    workspace_id?: string;
    workspaceId?: string;
    repo_owner?: string;
    repo_name?: string;
    repoName?: string;
    ref?: string;
    actual_state?: string;
    actualState?: string;
    desired_state?: string;
    desiredState?: string;
    connection_url?: string;
    connectionUrl?: string;
    labels?: Record<string, string> | null;
    ttlPolicy?: string | null;
}

export interface CreateWorkspaceRequest {
    repoOwner: string;
    repoName: string;
    repoProvider: string;
    ref: string;
    desiredState?: string | null;
    labels?: Record<string, string> | null;
    ttlPolicy?: string | null;
}
