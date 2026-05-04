import type { WorkspaceInfo } from './types';

export function trimTrailingSlashes(value: string): string {
    let end = value.length;
    while (end > 0 && value[end - 1] === '/') {
        end -= 1;
    }
    return value.slice(0, end);
}

export function trimLeadingSlashes(value: string): string {
    let start = 0;
    while (start < value.length && value[start] === '/') {
        start += 1;
    }
    return value.slice(start);
}

export function getWorkspaceRepo(workspace: WorkspaceInfo): { owner: string; repo: string } | undefined {
    const owner = workspace.source?.config?.owner
        ?? workspace.repo_owner
        ?? workspace.repoOwner;
    const repo = workspace.source?.config?.repo
        ?? workspace.repo_name
        ?? workspace.repoName;

    if (!owner || !repo) {
        console.warn('[QuickSpaces] Cannot resolve repo from workspace:', workspace);
        return undefined;
    }

    return { owner, repo };
}
