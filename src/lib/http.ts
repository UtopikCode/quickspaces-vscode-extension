import * as http from 'http';
import * as https from 'https';

export function httpGetJson<T>(url: string, options?: { headers?: Record<string, string> }): Promise<T> {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https://') ? https : http;
        const headers: Record<string, string> = {
            Accept: 'application/json',
            ...options?.headers,
        };

        const req = client.get(url, { headers }, res => {
            let body = '';

            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(body));
                    } catch (err) {
                        reject(new Error('Invalid JSON response'));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || 'Error'}`));
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

export function httpPostJson<T>(url: string, body: string, options?: { headers?: Record<string, string> }): Promise<T> {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https://') ? https : http;
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body).toString(),
            ...options?.headers,
        };

        const req = client.request(url, { method: 'POST', headers }, res => {
            let responseBody = '';

            res.on('data', chunk => { responseBody += chunk; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
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
        req.write(body);
        req.end();
    });
}
