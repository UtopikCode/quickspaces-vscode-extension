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
}

export interface Workspace {
    workspace_id?: string;
    repo_owner?: string;
    repo_name?: string;
    ref?: string;
    actual_state?: string;
    desired_state?: string;
    connection_url?: string;
}
