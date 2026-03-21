/// <reference types="vite/client" />

declare const __BUILD_VERSION__: string;
// Google Cast SDK type stubs
declare namespace cast {
  namespace framework {
    class CastContext {
      static getInstance(): CastContext;
      setOptions(options: { receiverApplicationId: string; autoJoinPolicy: unknown }): void;
      addEventListener(type: string, listener: (event: { sessionState: string }) => void): void;
      getCurrentSession(): CastSession | null;
      getCastState(): string;
      endCurrentSession(stopCasting: boolean): void;
    }
    class CastSession {
      getSessionId(): string;
      sendMessage(namespace: string, message: string): Promise<void>;
      getCastDevice(): { friendlyName: string };
    }
    class CastReceiverContext {
      static getInstance(): CastReceiverContext;
      start(options?: { disableIdleTimeout?: boolean; customNamespaces?: Record<string, string> }): void;
      stop(): void;
      addCustomMessageListener(namespace: string, listener: (event: { data: unknown }) => void): void;
    }
    enum CastContextEventType {
      SESSION_STATE_CHANGED = 'SESSION_STATE_CHANGED',
    }
    enum SessionState {
      SESSION_STARTED = 'SESSION_STARTED',
      SESSION_RESUMED = 'SESSION_RESUMED',
      SESSION_ENDED = 'SESSION_ENDED',
    }
  }
}
declare namespace chrome {
  namespace cast {
    enum AutoJoinPolicy {
      ORIGIN_SCOPED = 'origin_scoped',
    }
  }
}
// Cast sender callback
interface Window {
  __onGCastApiAvailable?: (isAvailable: boolean) => void;
}
// Custom element for cast button
declare namespace JSX {
  interface IntrinsicElements {
    'google-cast-launcher': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
  }
}
