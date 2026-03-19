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
    }
    class CastSession {
      getSessionId(): string;
    }
    class CastReceiverContext {
      static getInstance(): CastReceiverContext;
      start(): void;
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
