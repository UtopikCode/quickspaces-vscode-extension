import * as vscode from 'vscode';
import type { ControlPlane, WorkspaceInfo } from './types';
import { getWorkspaceRepo } from './utils';

function getWorkspaceRepoLabel(workspace: WorkspaceInfo): string | undefined {
    const repoInfo = getWorkspaceRepo(workspace);
    return repoInfo ? `${repoInfo.owner}/${repoInfo.repo}` : undefined;
}

function getWorkspaceTooltip(workspace: WorkspaceInfo, label: string): string {
    const tooltipLines: string[] = [];
    tooltipLines.push(label);

    const repoLabel = getWorkspaceRepoLabel(workspace);
    if (repoLabel) {
        tooltipLines.push(`📦 ${repoLabel}`);
    }

    if (workspace.ref) {
        tooltipLines.push(`🌿 ${workspace.ref}`);
    }

    const actualState = workspace.actual_state || workspace.actualState;
    const desiredState = workspace.desired_state || workspace.desiredState;
    if (actualState || desiredState) {
        const stateParts: string[] = [];
        if (actualState) {
            stateParts.push(`actual ${actualState}`);
        }
        if (desiredState) {
            stateParts.push(`desired ${desiredState}`);
        }
        tooltipLines.push(`⚙️ ${stateParts.join(', ')}`);
    }

    if (workspace.ttlPolicy) {
        tooltipLines.push(`⏱️ ${workspace.ttlPolicy}`);
    }

    if (workspace.workspace_id || workspace.workspaceId) {
        tooltipLines.push(`🆔 ${workspace.workspace_id ?? workspace.workspaceId}`);
    }

    const connectionUrl = workspace.connection_url ?? workspace.connectionUrl;
    if (connectionUrl) {
        tooltipLines.push(`🔗 ${connectionUrl}`);
    }

    return tooltipLines.join('\n');
}

export class ControlPlaneItem {
    constructor(public readonly controlPlane: ControlPlane) { }

    getTreeItem(): vscode.TreeItem {
        const item = new vscode.TreeItem(this.controlPlane.name, vscode.TreeItemCollapsibleState.Expanded);
        item.tooltip = this.controlPlane.url;
        item.iconPath = new vscode.ThemeIcon('server');
        item.contextValue = 'controlPlane';
        return item;
    }
}

export class WorkspaceItem {
    constructor(public readonly workspace: WorkspaceInfo, public readonly controlPlaneName: string) { }

    getTreeItem(): vscode.TreeItem {
        const repoLabel = getWorkspaceRepoLabel(this.workspace);
        const label = repoLabel ?? this.workspace.workspace_id ?? this.workspace.ref ?? 'Workspace';

        const description = this.workspace.actual_state || this.workspace.desired_state || '';
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None) as vscode.TreeItem & {
            workspace?: WorkspaceInfo;
            controlPlaneName?: string;
        };
        item.description = description;
        item.tooltip = getWorkspaceTooltip(this.workspace, label);
        item.iconPath = new vscode.ThemeIcon('repo');
        item.contextValue = 'workspace';
        item.workspace = this.workspace;
        item.controlPlaneName = this.controlPlaneName;
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
