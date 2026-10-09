// @effect-diagnostics nodeBuiltinImport:off -- Checkout boundary: the dev ports of a checkout are derived from
// -- its location on disk, which has to be probed synchronously because plain Node entrypoints (the web dev
// -- server) and Effect Config defaults both read it before any runtime exists.
import * as NodeCrypto from 'node:crypto';
import * as NodeFS from 'node:fs';
import * as NodePath from 'node:path';

const MAIN_CHECKOUT_API_PORT = 38123;
const WORKTREE_PORT_FLOOR = 10000;
const WORKTREE_PORT_PAIRS = 11000;

export type Ports = {
  readonly api: number;
  readonly web: number;
};

const gitEntry = (directory: string): string | undefined => {
  let current = NodePath.resolve(directory);
  for (;;) {
    const candidate = NodePath.join(current, '.git');
    if (NodeFS.existsSync(candidate)) return candidate;
    const parent = NodePath.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

const apiPortForCheckout = (directory: string): number => {
  const entry = gitEntry(directory);
  // Only the main checkout has a `.git` directory; a linked worktree has a `.git`
  // file pointing back at it. Worktrees hash their own path into a port pair, so
  // every checkout gets stable URLs without any configuration.
  if (entry === undefined || NodeFS.statSync(entry).isDirectory()) return MAIN_CHECKOUT_API_PORT;
  const digest = NodeCrypto.createHash('sha256').update(NodePath.dirname(entry)).digest();
  return WORKTREE_PORT_FLOOR + (digest.readUInt32BE(0) % WORKTREE_PORT_PAIRS) * 2;
};

const portsForCheckout = (directory: string): Ports => {
  const api = apiPortForCheckout(directory);
  return { api, web: api + 1 };
};

// @effect-diagnostics-next-line processEnv:off -- ConfigProvider boundary: the port base override is read from the raw environment here and nowhere else.
const portBaseOverride = (): number => Number(process.env.AGENTDOCK_PORT_BASE);

export const ports = (): Ports => {
  const override = portBaseOverride();
  if (Number.isInteger(override) && override > 0) return { api: override, web: override + 1 };
  return portsForCheckout(process.cwd());
};
