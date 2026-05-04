import { ControlPlane, CreateWorkspaceRequest, UpdateWorkspaceRequest, WorkspaceInfo } from './types';
import { trimTrailingSlashes } from './utils';
import { httpGetJson, httpRequestJson, httpProbe } from './http';

export class ControlPlaneApiClient {
    constructor(private readonly baseUrl: string, private readonly accessToken?: string) { }

    private get apiUrl(): string {
        return trimTrailingSlashes(this.baseUrl);
    }

    private get defaultHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'User-Agent': 'Quickspaces VS Code Extension',
        };

        if (this.accessToken) {
            headers.Authorization = `Bearer ${this.accessToken}`;
        }

        return headers;
    }

    async probe(): Promise<void> {
        await httpProbe(this.apiUrl);
    }

    async listWorkspaces(): Promise<WorkspaceInfo[]> {
        return httpGetJson<WorkspaceInfo[]>(`${this.apiUrl}/api/v1/workspaces`, {
            headers: this.defaultHeaders,
        });
    }

    async createWorkspace(requestBody: CreateWorkspaceRequest): Promise<void> {
        await httpRequestJson<void>(`${this.apiUrl}/api/v1/workspaces`, 'POST', JSON.stringify(requestBody), {
            headers: {
                ...this.defaultHeaders,
                'Content-Type': 'application/json',
            },
        });
    }

    async updateWorkspace(workspaceId: string, requestBody: Partial<UpdateWorkspaceRequest>): Promise<void> {
        await httpRequestJson<void>(`${this.apiUrl}/api/v1/workspaces/${workspaceId}`, 'PATCH', JSON.stringify(requestBody), {
            headers: {
                ...this.defaultHeaders,
                'Content-Type': 'application/json',
            },
        });
    }

    async deleteWorkspace(workspaceId: string): Promise<void> {
        await httpRequestJson<void>(`${this.apiUrl}/api/v1/workspaces/${workspaceId}`, 'DELETE', undefined, {
            headers: this.defaultHeaders,
        });
    }
}

export function createControlPlaneApiClient(controlPlane: ControlPlane, accessToken?: string): ControlPlaneApiClient {
    return new ControlPlaneApiClient(controlPlane.url, accessToken);
}
