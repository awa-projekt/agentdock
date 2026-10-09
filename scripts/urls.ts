import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import { localUrl } from '../packages/sdk/src/config.ts';
import { ports } from '../packages/sdk/src/ports.ts';

const localPorts = ports();
const flags = new Set(process.argv.slice(2));

const main = flags.has('--ports')
  ? Console.log(`${localPorts.api},${localPorts.web}`)
  : flags.has('--json')
    ? Console.log(
        JSON.stringify({
          api: { port: localPorts.api, url: localUrl(localPorts.api) },
          web: { port: localPorts.web, url: localUrl(localPorts.web) },
        }),
      )
    : Console.log(`api ${localUrl(localPorts.api)}\nweb ${localUrl(localPorts.web)}`);

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
