import { contextAgent, contextModel, createEvaluatorOptimizer, createRouter } from 'agentdock-patterns';
import { HumanMessage } from '@langchain/core/messages';
import { END, MessagesValue, START, StateGraph, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';

/**
 * The specialists are agents registered on the platform and the desk's model
 * is a platform model: `contextAgent` and `contextModel` resolve the names
 * this manifest binds when the workflow runs. The router picks the
 * specialists and writes each a task; the synthesizer merges their answers
 * into one reply.
 */
const desk = createRouter({
  model: contextModel('desk'),
  routes: [
    { name: 'billing', description: 'Invoices, duplicate charges and refunds.', agent: contextAgent('billing') },
    { name: 'tech', description: 'Errors, outages and bugs.', agent: contextAgent('tech') },
  ],
  synthesizerPrompt: 'Write one friendly reply to the customer that covers every answer below.',
  synthesize: true,
});

/** A reviewer checks the reply; a failed review sends it back to the desk with the feedback. */
const support = createEvaluatorOptimizer({
  generator: { name: 'desk', agent: desk },
  evaluator: {
    name: 'review',
    model: contextModel('review'),
    prompt:
      'Pass the reply only if it answers every question the customer asked, promises nothing the ' +
      'specialists did not confirm, and stays under 150 words.',
  },
  maxIterations: 2,
  name: 'support',
});

const Input = z.object({ text: z.string().describe('The customer message') });
const Output = z.object({ reply: z.string() });

const State = new StateSchema({
  text: z.string(),
  messages: MessagesValue,
  reply: z.string().default(''),
});

/**
 * `support` shares `messages`, so it is a subgraph node: the graph view draws
 * its roles, `support:desk` (expanded into `support:desk:route`,
 * `…:billing`, `…:tech`, `…:synthesize`) and `support:review`, with the
 * review looping back to the desk. The specialists run on the platform, so
 * each is a single step there.
 */
const graph = new StateGraph({ state: State, input: Input, output: Output })
  .addNode('prepare', (state) => ({ messages: [new HumanMessage(state.text)] }))
  .addNode('support', support)
  .addNode('respond', (state) => ({ reply: state.messages.at(-1)?.text ?? '' }))
  .addEdge(START, 'prepare')
  .addEdge('prepare', 'support')
  .addEdge('support', 'respond')
  .addEdge('respond', END)
  .compile();

export default graph;
