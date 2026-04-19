import * as vscode from 'vscode';
import type { ControlPlane, WorkspaceInfo } from './types';

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
