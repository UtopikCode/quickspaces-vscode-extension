import { ProviderInfo } from './types';

export const DEFAULT_REPO_PROVIDERS: ProviderInfo[] = [
    {
        id: 'github',
        label: 'GitHub',
        apiUrl: 'https://api.github.com',
        repoListPath: '/user/repos?per_page=100',
        repositoryUrlTemplate: 'https://github.com/{owner}/{repo}',
        authorizationUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        scope: 'repo',
    },
    {
        id: 'gitlab',
        label: 'GitLab',
        apiUrl: 'https://gitlab.com/api/v4',
        repoListPath: '/projects?membership=true&per_page=100',
        repositoryUrlTemplate: 'https://gitlab.com/{owner}/{repo}',
        authorizationUrl: 'https://gitlab.com/oauth/authorize',
        tokenUrl: 'https://gitlab.com/oauth/token',
        scope: 'read_user api',
    },
];
