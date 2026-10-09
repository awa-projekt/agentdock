import type { Root } from 'react-dom/client';

declare global {
  /** HMR state kept across reloads so the app re-renders into the same React root. */
  interface ImportMetaHot {
    readonly data: { root?: Root };
  }

  interface ImportMeta {
    readonly hot?: ImportMetaHot;
  }

  var __AGENTDOCK_API_BASE_URL__: string | undefined;
  var __AGENTDOCK_DISABLE_AUTH__: boolean | undefined;

  interface Window {
    __AGENTDOCK_API_BASE_URL__?: string;
    __AGENTDOCK_DISABLE_AUTH__?: boolean;
  }
}
