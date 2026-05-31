import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { build } from "esbuild";

const port = Number(process.env.PORT ?? "3001");
const appRoot = path.resolve(import.meta.dirname, "..");
loadEnv({ path: path.join(appRoot, ".env") });

const srcDir = path.join(appRoot, "src");
const buildDir = path.join(appRoot, ".generated");
const jsOutfile = path.join(buildDir, "app.js");
const cssOutfile = path.join(buildDir, "app.css");
const chatJsPath = fileURLToPath(import.meta.resolve("@mokronos/a2a-chat-ui"));
const chatCssPath = fileURLToPath(import.meta.resolve("@mokronos/a2a-chat-ui/styles.css"));
const tailwindBin = path.join(appRoot, "node_modules", ".bin", "tailwindcss");
const publicApiBaseUrl = process.env.AGENTDOCK_PUBLIC_API_URL;

if (!publicApiBaseUrl) {
  throw new Error("AGENTDOCK_PUBLIC_API_URL must be set for the web dashboard.");
}

const scriptJson = (value: string): string => JSON.stringify(value).replaceAll("<", "\\u003c");

const html = (apiBaseUrl: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Agentdock Web</title>
    <link rel="stylesheet" href="/assets/app.css" />
    <link rel="stylesheet" href="/assets/a2a-chat.css" />
    <script>window.__AGENTDOCK_API_BASE_URL__ = ${scriptJson(apiBaseUrl)};</script>
    <script type="module" src="/assets/app.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

const sendText = (res: ServerResponse, status: number, contentType: string, body: string): void => {
  res.statusCode = status;
  res.setHeader("content-type", contentType);
  res.end(body);
};

const serveFile = (req: IncomingMessage, res: ServerResponse, filePath: string, contentType: string): void => {
  const { size } = statSync(filePath);
  res.statusCode = 200;
  res.setHeader("content-type", contentType);
  res.setHeader("content-length", String(size));

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  createReadStream(filePath).pipe(res);
};

const runCommand = (command: string, args: ReadonlyArray<string>): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: appRoot,
      env: process.env,
      stdio: "pipe",
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code ?? "unknown"}`));
    });
  });

const assetInputs = [
  path.join(srcDir, "frontend.tsx"),
  path.join(srcDir, "App.tsx"),
  path.join(srcDir, "AgentGraphView.tsx"),
  path.join(srcDir, "WorkflowEditorView.tsx"),
  path.join(srcDir, "app.css"),
  path.join(srcDir, "index.css"),
  path.join(appRoot, "styles", "globals.css"),
  chatJsPath,
  chatCssPath,
] as const;

let lastBuildStartedAt = 0;
let currentBuild: Promise<void> | null = null;

const shouldRebuildAssets = async (): Promise<boolean> => {
  if (!existsSync(jsOutfile) || !existsSync(cssOutfile)) {
    return true;
  }

  const outputStats = await Promise.all([stat(jsOutfile), stat(cssOutfile)]);
  const newestOutputMtime = Math.min(...outputStats.map((entry) => entry.mtimeMs));
  const inputStats = await Promise.all(assetInputs.map((filePath) => stat(filePath)));
  return inputStats.some((entry) => entry.mtimeMs > newestOutputMtime);
};

const buildAssets = async (): Promise<void> => {
  mkdirSync(buildDir, { recursive: true });

  await build({
    entryPoints: [path.join(srcDir, "frontend.tsx")],
    outfile: jsOutfile,
    bundle: true,
    format: "esm",
    jsx: "automatic",
    platform: "browser",
    target: ["es2022"],
    sourcemap: process.env.NODE_ENV === "production" ? false : "inline",
    logLevel: "silent",
  });

  await runCommand(tailwindBin, ["-i", path.join(srcDir, "app.css"), "-o", cssOutfile]);
};

const ensureAssets = async (): Promise<void> => {
  if (currentBuild) {
    return currentBuild;
  }

  const now = Date.now();
  const needsBuild = await shouldRebuildAssets();
  if (!needsBuild && now - lastBuildStartedAt < 250) {
    return;
  }

  lastBuildStartedAt = now;
  currentBuild = buildAssets().finally(() => {
    currentBuild = null;
  });
  return currentBuild;
};

const server = createServer((req, res) => {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const pathname = requestUrl.pathname;

  if (pathname === "/assets/app.js") {
    void ensureAssets()
      .then(() => {
        serveFile(req, res, jsOutfile, "text/javascript; charset=utf-8");
      })
      .catch((error) => {
        sendText(res, 500, "text/plain; charset=utf-8", String(error));
      });
    return;
  }

  if (pathname === "/assets/app.css") {
    void ensureAssets()
      .then(() => {
        serveFile(req, res, cssOutfile, "text/css; charset=utf-8");
      })
      .catch((error) => {
        sendText(res, 500, "text/plain; charset=utf-8", String(error));
      });
    return;
  }

  if (pathname === "/assets/a2a-chat.css") {
    serveFile(req, res, chatCssPath, "text/css; charset=utf-8");
    return;
  }

  sendText(res, 200, "text/html; charset=utf-8", html(publicApiBaseUrl));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Web server running at http://127.0.0.1:${port}`);
});
