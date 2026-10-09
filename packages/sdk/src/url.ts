export const localUrl = (port: number): string => `http://127.0.0.1:${port}`;

export const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/$/, '');
