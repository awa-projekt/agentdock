import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const REFERENCE_DIR = join(import.meta.dirname, "../.references");

const repos = [
  { name: "effect", url: "https://github.com/Effect-TS/effect.git" },
  { name: "effect-atom", url: "https://github.com/tim-smart/effect-atom.git" },
  { name: "executor", url: "https://github.com/RhysSullivan/executor.git" },
  { name: "opencode", url: "https://github.com/anomalyco/opencode.git" },
  {
    name: "tanstack-router",
    url: "https://github.com/TanStack/router.git",
  },
];

await mkdir(REFERENCE_DIR, { recursive: true });

const run = (command: string, args: ReadonlyArray<string>): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? -1}`));
    });
  });

for (const repo of repos) {
  const dest = join(REFERENCE_DIR, repo.name);
  if (existsSync(dest)) {
    console.log(`Pulling ${repo.name}...`);
    await run("git", ["-C", dest, "pull", "--ff-only"]);
  } else {
    console.log(`Cloning ${repo.name}...`);
    await run("git", ["clone", "--depth", "1", repo.url, dest]);
  }
  console.log(`  ✓ ${repo.name}`);
}
