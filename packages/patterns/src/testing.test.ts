import { describe, expect, it } from '@effect/vitest';
import { tool } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { request } from './test-support.ts';
import { type ModelTurn, ScriptError, scriptedModel, UsageTracker } from './testing.ts';

const getWeather = tool(async ({ city }) => ({ city, temp: 21 }), {
  name: 'get_weather',
  description: 'Weather for a city.',
  schema: z.object({ city: z.string() }),
});

const Forecast = z.object({ city: z.string(), temp: z.number() }).meta({ title: 'Forecast' });

const weatherPolicy = (turn: ModelTurn) => {
  if (!turn.called('get_weather')) {
    return turn.callMany(['get_weather', { city: 'Berlin' }], ['get_weather', { city: 'Rome' }]);
  }
  return turn.structured(Forecast.parse(turn.jsonResults('get_weather')[0]));
};

describe('ScriptedModel', () => {
  it('drives an agent with parallel tool calls and structured output; the tracker counts it', async () => {
    const agent = createAgent({ model: scriptedModel(weatherPolicy), tools: [getWeather], responseFormat: Forecast });
    const tracker = new UsageTracker();

    const result = await agent.invoke(request('weather?'), { callbacks: [tracker] });

    expect(result.structuredResponse).toEqual({ city: 'Berlin', temp: 21 });
    const summary = tracker.summary();
    expect(summary.modelCalls).toBe(2);
    expect(summary.tools).toEqual({ get_weather: 2 });
    expect(summary.inputTokens).toBeGreaterThan(0);
  });

  it('answers withStructuredOutput through the single bound tool', async () => {
    const model = scriptedModel((turn) => turn.structured({ city: 'Oslo', temp: 3 }));
    expect(await model.withStructuredOutput(Forecast, { name: 'Forecast' }).invoke('hi')).toEqual({
      city: 'Oslo',
      temp: 3,
    });
  });

  it('rejects calls of unbound tools', async () => {
    const model = scriptedModel((turn) => turn.call('does_not_exist'));
    await expect(createAgent({ model, tools: [getWeather] }).invoke(request('x'))).rejects.toThrow(ScriptError);
  });

  it('rejects plain text when a tool call is forced', async () => {
    const model = scriptedModel((turn) => turn.say('plain text'));
    await expect(model.withStructuredOutput(Forecast, { name: 'Forecast' }).invoke('hi')).rejects.toThrow(
      /forces a tool call/,
    );
  });

  it('answers native structured output with JSON text and no tool bound', async () => {
    const seen: Array<readonly [string | undefined, ReadonlyArray<string>]> = [];
    const model = scriptedModel((turn) => {
      seen.push([turn.responseFormat?.name, turn.toolNames]);
      return turn.structured({ city: 'Oslo', temp: 3 });
    });

    const forecast = await model
      .withStructuredOutput(Forecast, { name: 'Forecast', method: 'jsonSchema' })
      .invoke('hi');

    expect(forecast).toEqual({ city: 'Oslo', temp: 3 });
    expect(seen).toEqual([['Forecast', []]]);
  });

  it('makes createAgent use the provider strategy when the profile declares native support', async () => {
    const seen: Array<boolean> = [];
    const model = scriptedModel(
      (turn) => {
        seen.push(turn.responseFormat !== undefined);
        return weatherPolicy(turn);
      },
      { profile: { structuredOutput: true } },
    );
    const agent = createAgent({ model, tools: [getWeather], responseFormat: Forecast });

    expect((await agent.invoke(request('weather?'))).structuredResponse).toEqual({ city: 'Berlin', temp: 21 });
    expect(seen).toEqual([true, true]);
  });
});
