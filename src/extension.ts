import * as vscode from 'vscode';
import { QuickspacesTreeProvider, ControlPlaneItem, WorkspaceItem, StatusItem } from './lib/treeProvider';
import type { ControlPlane } from './lib/types';

export function activate(context: vscode.ExtensionContext) {
    const provider = new QuickspacesTreeProvider(context);

    const treeView = vscode.window.createTreeView('quickspacesView', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });

    provider.onControlPlaneChanged = (label: string) => {
        treeView.description = label;
        vscode.commands.executeCommand('setContext', 'quickspaces.hasControlPlane', !!label);
    };

    context.subscriptions.push(treeView);
    context.subscriptions.push(vscode.window.registerUriHandler(provider));

    context.subscriptions.push(
        vscode.commands.registerCommand('quickspaces.addControlPlane', async () => {
            const addedControlPlane = await provider.addControlPlane();
            if (addedControlPlane) {
                const treeItem = new ControlPlaneItem(addedControlPlane);
                void treeView.reveal(treeItem, { expand: true });
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('quickspaces.configureControlPlane', async (controlPlaneOrItem: ControlPlane | ControlPlaneItem | vscode.TreeItem | undefined) => {
            await provider.configureControlPlane(controlPlaneOrItem);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('quickspaces.addWorkspace', async (controlPlaneOrItem: ControlPlane | ControlPlaneItem | vscode.TreeItem | undefined) => {
            await provider.addWorkspace(controlPlaneOrItem);
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

export type { ControlPlane, Workspace } from './lib/types';
export { QuickspacesTreeProvider, ControlPlaneItem, WorkspaceItem, StatusItem, httpGetJson, httpPostJson } from './lib/treeProvider';
