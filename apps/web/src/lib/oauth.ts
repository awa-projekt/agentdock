import { Json, jsonString, type OAuthSessionView } from 'agentdock-sdk/schemas';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { apiOrigin, getOAuthSession } from '@/lib/api';

const OAuthPopupMessage = Schema.Struct({
  type: Schema.Literal('agentdock:oauth-result'),
  ok: Schema.Boolean,
  payload: Schema.optional(Json),
});

const decodeOAuthPopupMessage = Schema.decodeUnknownOption(OAuthPopupMessage);

const POLL_INTERVAL_MS = 1_000;
const TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Open the authorization popup and resolve with the session once the server reports it left `pending`.
 *
 * The session is the source of truth: a provider page with a strict Cross-Origin-Opener-Policy severs the
 * popup from this window, so `popup.closed` and the callback's `postMessage` cannot be relied on.
 */
export const authorizeInPopup = (session: OAuthSessionView, signal: AbortSignal): Promise<OAuthSessionView> =>
  new Promise((resolve, reject) => {
    if (session.state.status !== 'pending') {
      resolve(session);
      return;
    }
    const popup = window.open(session.state.authorizationUrl, 'agentdock-oauth', 'popup,width=520,height=720');
    if (!popup) {
      reject(new Error('OAuth popup was blocked.'));
      return;
    }

    let pollTimer: number | undefined;
    let done = false;

    const settle = (outcome: () => void) => {
      if (done) return;
      done = true;
      window.clearTimeout(pollTimer);
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      signal.removeEventListener('abort', onAbort);
      popup.close();
      outcome();
    };

    const poll = () =>
      getOAuthSession(session.id).then(
        (polled) => {
          if (done) return;
          if (polled.state.status !== 'pending') {
            settle(() => resolve(polled));
          } else {
            pollTimer = window.setTimeout(poll, POLL_INTERVAL_MS);
          }
        },
        (error) => settle(() => reject(error)),
      );

    function onMessage(event: MessageEvent) {
      if (event.origin !== apiOrigin) return;
      const decoded = decodeOAuthPopupMessage(event.data);
      if (Option.isNone(decoded) || decoded.value.ok) return;
      const message = jsonString(decoded.value.payload, 'error') ?? 'OAuth authorization failed.';
      settle(() => reject(new Error(message)));
    }

    function onAbort() {
      settle(() => reject(new Error('OAuth authorization was cancelled.')));
    }

    const timeout = window.setTimeout(
      () => settle(() => reject(new Error('OAuth authorization timed out.'))),
      TIMEOUT_MS,
    );
    window.addEventListener('message', onMessage);
    signal.addEventListener('abort', onAbort);
    pollTimer = window.setTimeout(poll, POLL_INTERVAL_MS);
  });
