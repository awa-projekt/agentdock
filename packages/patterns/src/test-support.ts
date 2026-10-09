import type { AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import { z } from 'zod';
import type { Participant } from './core.ts';
import { type ModelTurn, type ScriptedModelOptions, scriptedModel } from './testing.ts';

/** Test helpers shared by the pattern tests. */

type Role = (turn: ModelTurn) => AIMessage | string;

const ROLE = /role=(\w+)/;

/** A scripted model that dispatches on a `role=<name>` marker in the system prompt. */
export const roleModel = (roles: Readonly<Record<string, Role>>, options: ScriptedModelOptions = {}) =>
  scriptedModel((turn) => {
    const role = ROLE.exec(turn.system)?.[1];
    const policy = role === undefined ? undefined : roles[role];
    if (!policy) throw new Error(`unexpected system prompt: ${JSON.stringify(turn.system)}`);
    return policy(turn);
  }, options);

/** An agent that answers `<prefix>: <last human message>` without calling its tools. */
export const echoAgent = (prefix: string, name = prefix, tools: ReadonlyArray<typeof add> = []) =>
  createAgent({
    model: roleModel({ echo: (turn) => turn.say(`${prefix}: ${turn.lastHuman}`) }),
    tools: [...tools],
    systemPrompt: 'role=echo',
    name,
  });

/**
 * A participant with a tool: its graph has a model and a tools step, so the
 * graph view expands it (LangGraph JS draws a one-step subgraph as one node).
 */
export const toolSpec = (name: string): Participant => ({
  name,
  description: `The ${name} agent.`,
  agent: echoAgent(name, name, [add]),
});

export const spec = (name: string, prefix = name): Participant => ({
  name,
  description: `The ${name} agent.`,
  agent: echoAgent(prefix, name),
});

export const Answer = z.object({ text: z.string() }).meta({ title: 'Answer', description: 'Final answer.' });

export const add = tool(async ({ a, b }) => a + b, {
  name: 'add',
  description: 'Add two numbers.',
  schema: z.object({ a: z.number(), b: z.number() }),
});

export const request = (text: string) => ({ messages: [{ role: 'user', content: text }] });
