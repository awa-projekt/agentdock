// @effect-diagnostics nodeBuiltinImport:off processEnv:off globalConsole:off
// -- Plain Node.js entrypoint: the esbuild/tailwind dev+prod server for the dashboard. It owns no Effect
// -- runtime (nothing here is an Effect) and the diagnostics apply to every file in the project regardless
// -- of whether it imports `effect`, so they cannot be avoided by keeping this module Effect-free.

import * as NodeChildProcess from 'node:child_process';
import * as NodeFS from 'node:fs';
import * as NodeFSP from 'node:fs/promises';
import * as NodeHttp from 'node:http';
import * as NodePath from 'node:path';
import * as NodeURL from 'node:url';
import { localUrl } from 'agentdock-sdk/config';
import { ports } from 'agentdock-sdk/ports';
import { config as loadEnv } from 'dotenv';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BootScreen } from './components/BootScreen';

const appRoot = NodePath.resolve(import.meta.dirname, '..');
loadEnv({ path: NodePath.resolve(appRoot, '..', '..', '.env') });

const localPorts = ports();
const port = Number(process.env.AGENTDOCK_WEB_PORT ?? localPorts.web);
const host = process.env.AGENTDOCK_WEB_HOST ?? process.env.AGENTDOCK_SERVER_HOST ?? '127.0.0.1';
const buildMode = process.env.NODE_ENV === 'development' ? 'development' : 'production';
const isDevelopment = buildMode === 'development';
const authDisabled = process.env.AGENTDOCK_DISABLE_AUTH === '1' || process.env.AGENTDOCK_DISABLE_AUTH === 'true';

const srcDir = NodePath.join(appRoot, 'src');
const buildDir = NodePath.join(appRoot, '.generated');
const jsOutfile = NodePath.join(buildDir, 'app.js');
const cssOutfile = NodePath.join(buildDir, 'app.css');
const buildModeFile = NodePath.join(buildDir, '.mode');
const katexCssPath = NodeURL.fileURLToPath(import.meta.resolve('katex/dist/katex.min.css'));
const katexFontsDir = NodePath.join(NodePath.dirname(katexCssPath), 'fonts');
const faviconPath = NodePath.join(appRoot, 'src', 'favicon.svg');
const tailwindBin = NodePath.join(appRoot, 'node_modules', '.bin', 'tailwindcss');
const publicApiBaseUrl = process.env.AGENTDOCK_PUBLIC_API_URL ?? localUrl(localPorts.api);

const scriptJson = (value: string): string => JSON.stringify(value).replaceAll('<', '\\u003c');

const bootMarkup = renderToStaticMarkup(createElement(BootScreen));

const html = (apiBaseUrl: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Agentdock Web</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <script>const theme = localStorage.getItem('agentdock-theme'); document.documentElement.classList.toggle('dark', theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches));</script>
    <link rel="stylesheet" href="/assets/app.css" />
    <link rel="stylesheet" href="/assets/katex.min.css" />
    <script>window.__AGENTDOCK_API_BASE_URL__ = ${scriptJson(apiBaseUrl)}; window.__AGENTDOCK_DISABLE_AUTH__ = ${authDisabled ? 'true' : 'false'};</script>
    <script type="module" src="/assets/app.js"></script>
  </head>
  <body>
    <div id="root">${bootMarkup}</div>
  </body>
</html>`;

const sendText = (res: NodeHttp.ServerResponse, status: number, contentType: string, body: string): void => {
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.end(body);
};

const serveFile = (
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
  filePath: string,
  contentType: string,
): void => {
  const { size } = NodeFS.statSync(filePath);
  res.statusCode = 200;
  res.setHeader('content-type', contentType);
  res.setHeader('content-length', String(size));

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  NodeFS.createReadStream(filePath).pipe(res);
};

const fontContentType = (filePath: string): string => {
  const extension = NodePath.extname(filePath);
  if (extension === '.woff2') return 'font/woff2';
  if (extension === '.woff') return 'font/woff';
  if (extension === '.ttf') return 'font/ttf';
  return 'application/octet-stream';
};

const scriptContentType = (filePath: string): string =>
  filePath.endsWith('.map') ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8';

const runCommand = (command: string, args: ReadonlyArray<string>): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: appRoot,
      env: process.env,
      stdio: 'pipe',
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code ?? 'unknown'}`));
    });
  });

// Inputs that live outside the bundled source tree. Everything under srcDir is
// discovered dynamically so adding a new view/component never silently serves a
// stale bundle in development.
const externalInputs = [NodePath.join(appRoot, 'styles', 'globals.css'), katexCssPath] as const;

/** All files reachable under `dir`, recursively, as absolute paths. */
const collectFiles = async (dir: string): Promise<Array<string>> => {
  const entries = await NodeFSP.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const fullPath = NodePath.join(dir, entry.name);
      return entry.isDirectory() ? collectFiles(fullPath) : Promise.resolve([fullPath]);
    }),
  );
  return nested.flat();
};

let currentBuild: Promise<void> | null = null;
let assetsBuilt = false;

const shouldRebuildAssets = async (): Promise<boolean> => {
  if (!NodeFS.existsSync(jsOutfile) || !NodeFS.existsSync(cssOutfile) || !NodeFS.existsSync(buildModeFile)) {
    return true;
  }

  const previousBuildMode = await NodeFSP.readFile(buildModeFile, 'utf8').catch(() => '');
  if (previousBuildMode.trim() !== buildMode) {
    return true;
  }

  // The mode marker is written last on every successful build, so its mtime is a
  // reliable "build finished" timestamp. We must NOT derive that timestamp from
  // the output files: tailwind leaves cssOutfile untouched when the generated CSS
  // is unchanged, so its mtime stays frozen and would make the staleness check
  // perpetually true — forcing a full rebuild on every single asset request.
  const buildMtime = (await NodeFSP.stat(buildModeFile)).mtimeMs;
  const inputs = [...(await collectFiles(srcDir)), ...externalInputs];
  const inputStats = await Promise.all(inputs.map((filePath) => NodeFSP.stat(filePath)));
  return inputStats.some((entry) => entry.mtimeMs > buildMtime);
};

const buildAssets = async (): Promise<void> => {
  NodeFS.mkdirSync(buildDir, { recursive: true });

  await build({
    entryPoints: [NodePath.join(srcDir, 'frontend.tsx')],
    outdir: buildDir,
    bundle: true,
    format: 'esm',
    splitting: true,
    entryNames: 'app',
    chunkNames: 'chunks/[name]-[hash]',
    jsx: 'automatic',
    platform: 'browser',
    target: ['es2022'],
    minify: !isDevelopment,
    sourcemap: isDevelopment,
    logLevel: 'silent',
  });

  await runCommand(tailwindBin, ['-i', NodePath.join(srcDir, 'app.css'), '-o', cssOutfile]);
  await NodeFSP.writeFile(buildModeFile, `${buildMode}\n`);
};

const ensureAssets = async (): Promise<void> => {
  if (currentBuild) {
    return currentBuild;
  }

  // Production has no source watching, so the bundle is built once per process.
  // After that, every asset request (including all code-split chunks) is served
  // straight from disk with no staleness check or rebuild.
  if (!isDevelopment && assetsBuilt) {
    return;
  }

  const needsBuild = await shouldRebuildAssets();
  if (!needsBuild) {
    assetsBuilt = true;
    return;
  }

  currentBuild = buildAssets()
    .then(() => {
      assetsBuilt = true;
    })
    .finally(() => {
      currentBuild = null;
    });
  return currentBuild;
};

const server = NodeHttp.createServer((req, res) => {
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const pathname = requestUrl.pathname;

  if (pathname === '/assets/app.js') {
    void ensureAssets()
      .then(() => {
        serveFile(req, res, jsOutfile, 'text/javascript; charset=utf-8');
      })
      .catch((error) => {
        sendText(res, 500, 'text/plain; charset=utf-8', String(error));
      });
    return;
  }

  if (isDevelopment && pathname === '/assets/app.js.map') {
    void ensureAssets()
      .then(() => {
        serveFile(req, res, `${jsOutfile}.map`, 'application/json; charset=utf-8');
      })
      .catch((error) => {
        sendText(res, 500, 'text/plain; charset=utf-8', String(error));
      });
    return;
  }

  if (pathname === '/assets/app.css') {
    void ensureAssets()
      .then(() => {
        serveFile(req, res, cssOutfile, 'text/css; charset=utf-8');
      })
      .catch((error) => {
        sendText(res, 500, 'text/plain; charset=utf-8', String(error));
      });
    return;
  }

  if (pathname === '/favicon.svg') {
    serveFile(req, res, faviconPath, 'image/svg+xml');
    return;
  }

  if (pathname === '/assets/katex.min.css') {
    serveFile(req, res, katexCssPath, 'text/css; charset=utf-8');
    return;
  }

  if (pathname.startsWith('/assets/fonts/')) {
    const fontName = NodePath.basename(pathname);
    const fontPath = NodePath.join(katexFontsDir, fontName);
    const relativeFontPath = NodePath.relative(katexFontsDir, fontPath);
    if (NodeFS.existsSync(fontPath) && !relativeFontPath.startsWith('..') && !NodePath.isAbsolute(relativeFontPath)) {
      serveFile(req, res, fontPath, fontContentType(fontPath));
      return;
    }
    sendText(res, 404, 'text/plain; charset=utf-8', 'Not found');
    return;
  }

  if (
    pathname.startsWith('/assets/chunks/') &&
    (pathname.endsWith('.js') || (isDevelopment && pathname.endsWith('.js.map')))
  ) {
    void ensureAssets()
      .then(() => {
        const filePath = NodePath.join(buildDir, pathname.slice('/assets/'.length));
        const relativeFilePath = NodePath.relative(buildDir, filePath);
        if (
          NodeFS.existsSync(filePath) &&
          !relativeFilePath.startsWith('..') &&
          !NodePath.isAbsolute(relativeFilePath)
        ) {
          serveFile(req, res, filePath, scriptContentType(filePath));
          return;
        }
        sendText(res, 404, 'text/plain; charset=utf-8', 'Not found');
      })
      .catch((error) => {
        sendText(res, 500, 'text/plain; charset=utf-8', String(error));
      });
    return;
  }

  if (pathname.startsWith('/assets/')) {
    sendText(res, 404, 'text/plain; charset=utf-8', 'Not found');
    return;
  }

  sendText(res, 200, 'text/html; charset=utf-8', html(publicApiBaseUrl));
});

server.listen(port, host, () => {
  console.log(`Web server running at http://127.0.0.1:${port}`);
});
