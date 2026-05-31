declare global {
  interface ImportMetaHot {
    readonly data: Record<string, any>;
  }

  interface ImportMeta {
    readonly hot?: ImportMetaHot;
  }

  var __AGENTDOCK_API_BASE_URL__: string | undefined;

  interface Window {
    __AGENTDOCK_API_BASE_URL__?: string;
  }
}

export {};
