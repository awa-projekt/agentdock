import {
  createExecutor,
  ElicitationResponse,
  makeTestConfig,
  type AnyPlugin,
} from "@executor-js/sdk/core";
import { mcpPlugin } from "@executor-js/plugin-mcp";
import { createExecutionEngine } from "@executor-js/execution/core";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";
import { Effect } from "effect";

const plugins = [mcpPlugin() as ReturnType<typeof mcpPlugin> & AnyPlugin] as const;

const executor = await Effect.runPromise(
  createExecutor({
    ...makeTestConfig({ plugins }),
    onElicitation: "accept-all",
  }),
);

const scope = executor.scopes[0]!.id;

// Remote MCP server
await Effect.runPromise(
  executor.mcp.addSource({
    scope,
    transport: "remote",
    name: "Context7",
    endpoint: "https://mcp.context7.com/mcp",
  }),
);

await Effect.runPromise(
  executor.mcp.addSource({
    scope,
    transport: "remote",
    name: "LinearApp",
    endpoint: "https://mcp.linear.app/mcp",
  }),
);

// Every MCP tool is now part of the unified catalog
const tools = await Effect.runPromise(executor.tools.list());

console.log(tools);
const result = await Effect.runPromise(
  executor.tools.invoke("context7.resolve_library_id", {
    query: "basics",
    libraryName: "effect-ts",
  }),
);

const result2 = await Effect.runPromise(
  executor.tools.invoke("context7.query_docs", {
    libraryId: "/effect-ts/effect",
    query: "basics",
  }),
);




console.log(result);
console.log(result2);

const engine = createExecutionEngine({
  executor,
  codeExecutor: makeQuickJsExecutor({
    timeoutMs: 2_000,
    memoryLimitBytes: 32 * 1024 * 1024,
  }),
});


const engine_result = await Effect.runPromise(
  engine.execute(
    `
      const pets = await tools.context7.resolve_library_id({
          query: "basics",
          libraryName: "effect-ts",
        });
      return pets.length;
    `,
    {
      onElicitation: (ctx) => {
        // A tool asked for user input mid-execution. Your UI decides what to do.
        console.log("tool needs input:", ctx.request);
        return Effect.succeed(ElicitationResponse.make({ action: "decline" }));
      },
    },
  ),
);

console.log(engine_result);

console.log(await Effect.runPromise(engine.getDescription));
