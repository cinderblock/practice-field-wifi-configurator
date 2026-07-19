import type { TelemetryUpdate } from './types.js';

/**
 * Per-station coalescer for telemetry broadcasts.
 *
 * Robot packet capture emits an update per sniffed packet — ~40-50/s per
 * robot, 250+/s with six robots on the field — and broadcasting each one
 * floods every WebSocket client (measured 56 KB/s of a 58 KB/s scores
 * socket). On a slow display (a Chromecast on TV Wi-Fi) the backlog queues
 * ahead of score updates, making the scoreboard visibly lag reality.
 *
 * Steady-state updates are throttled to one per station per interval, latest
 * wins. Updates whose dsStatus changed (enable, e-stop, mode, comms) flush
 * immediately so control indicators stay snappy.
 */
export function createTelemetryCoalescer(
  send: (update: TelemetryUpdate) => void,
  intervalMs = 250,
): (update: TelemetryUpdate) => void {
  interface StationState {
    latest: TelemetryUpdate | null;
    lastSentAt: number;
    lastStatusKey: string;
    timer: ReturnType<typeof setTimeout> | null;
  }
  const stations = new Map<string, StationState>();

  const statusKey = (u: TelemetryUpdate) => (u.dsStatus ? JSON.stringify(u.dsStatus) : '');

  const flush = (st: StationState, update: TelemetryUpdate) => {
    st.latest = null;
    st.lastSentAt = Date.now();
    if (update.dsStatus !== undefined) st.lastStatusKey = statusKey(update);
    send(update);
  };

  return update => {
    let st = stations.get(update.station);
    if (!st) {
      st = { latest: null, lastSentAt: 0, lastStatusKey: '', timer: null };
      stations.set(update.station, st);
    }

    const now = Date.now();
    const statusChanged = update.dsStatus !== undefined && statusKey(update) !== st.lastStatusKey;

    if (statusChanged || now - st.lastSentAt >= intervalMs) {
      if (st.timer) {
        clearTimeout(st.timer);
        st.timer = null;
      }
      flush(st, update);
      return;
    }

    // Within the window — stash the latest and flush on the trailing edge
    st.latest = update;
    if (!st.timer) {
      st.timer = setTimeout(
        () => {
          st.timer = null;
          if (st.latest) flush(st, st.latest);
        },
        Math.max(0, intervalMs - (now - st.lastSentAt)),
      );
    }
  };
}
