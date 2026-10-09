import { ports } from './ports';
import { localUrl } from './url';

export { localUrl, normalizeBaseUrl } from './url';

// @effect-diagnostics-next-line processEnv:off -- ConfigProvider boundary: the SDK's default API URL is seeded from the raw environment here and nowhere else.
export const apiBaseUrlFromEnv = (): string => process.env.AGENTDOCK_API_URL ?? localUrl(ports().api);
