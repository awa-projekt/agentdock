import * as Effect from 'effect/Effect';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import { AgentdockApi } from '../api';
import { ChangeFeed } from '../events/service';

export const eventsHandler = HttpApiBuilder.group(AgentdockApi, 'events', (handlers) =>
  handlers.handle('events', () => ChangeFeed.use((changes) => Effect.succeed(changes.events))),
);
