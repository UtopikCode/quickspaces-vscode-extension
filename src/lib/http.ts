import * as http from 'http';
import * as https from 'https';

export function httpRequestJson<T>(url: string, method: string, body?: string, options?: { headers?: Record<string, string> }): Promise<T> {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https://') ? https : http;
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'User-Agent': 'Quickspaces VS Code Extension',
            ...options?.headers,
        };

        if (body !== undefined) {
            headers['Content-Length'] = Buffer.byteLength(body).toString();
        }

        const req = client.request(url, { method, headers }, res => {
            let responseBody = '';

            res.on('data', chunk => { responseBody += chunk; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    if (!responseBody) {
                        resolve(undefined as unknown as T);
                        return;
                    }

                    try {
                        resolve(JSON.parse(responseBody));
                    } catch (err) {
                        reject(new Error('Invalid JSON response'));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || 'Error'}`));
                }
            });
        });

        req.on('error', reject);
        if (body !== undefined) {
            req.write(body);
        }
        req.end();
    });
}

export function httpGetJson<T>(url: string, options?: { headers?: Record<string, string> }): Promise<T> {
    return httpRequestJson<T>(url, 'GET', undefined, options);
}

export function httpPostJson<T>(url: string, body: string, options?: { headers?: Record<string, string> }): Promise<T> {
    return httpRequestJson<T>(url, 'POST', body, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...options?.headers,
        },
    });
}
