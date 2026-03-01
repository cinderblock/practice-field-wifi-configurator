import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Fab from '@mui/material/Fab';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { StatusEntry, Status } from '../../../src/types';
import type { Message as RadioMessage } from 'syslog-server';
import { useHistory, useUpdateCallback, useRadioMessageCallback } from '../hooks/useBackend';

// ── Types ─────────────────────────────────────────────────────────────

type LogSource = 'status' | 'radio';

interface LogEntry {
  id: number;
  timestamp: number;
  source: LogSource;
  message: string;
  level: 'info' | 'warn' | 'error';
}

// ── Constants ─────────────────────────────────────────────────────────

let nextId = 0;

const MAX_LOGS = 10_000;
const ROW_HEIGHT = 26;
const AUTO_SCROLL_THRESHOLD = 50;
const OVERSCAN = 30;

// ── Helpers ───────────────────────────────────────────────────────────

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function statusLevel(status: Status): LogEntry['level'] {
  if (status === 'ERROR') return 'error';
  if (status === 'CONFIGURING' || status === 'BOOTING') return 'warn';
  return 'info';
}

function statusEntryToLog(entry: StatusEntry): Omit<LogEntry, 'id'> {
  const r = entry.radioUpdate;
  if (!r) return { timestamp: entry.timestamp, source: 'status', message: 'No radio data', level: 'warn' };

  // Single loop instead of entries().filter().map()
  let linked = '';
  for (const name in r.stationStatuses) {
    const s = r.stationStatuses[name as keyof typeof r.stationStatuses];
    if (s?.isLinked) linked += (linked ? ', ' : '') + name;
  }

  let message = `${r.status} \u2502 Ch ${r.channel} (${r.channelBandwidth})`;
  if (linked) message += ` \u2502 Linked: ${linked}`;

  return {
    timestamp: entry.timestamp,
    source: 'status',
    message,
    level: statusLevel(r.status),
  };
}

// Pre-compiled regexes to avoid re-creation on each call
const errorRe = /error|fail|crit/i;
const warnRe = /warn/i;

function radioMessageToLog(msg: RadioMessage): Omit<LogEntry, 'id'> {
  const text = msg.message.trim();
  const level: LogEntry['level'] = errorRe.test(text) ? 'error' : warnRe.test(text) ? 'warn' : 'info';
  return {
    // msg.date was mutated from string to Date by isRadioMessage() in useBackend
    timestamp: msg.date.getTime(),
    source: 'radio',
    message: `[${msg.host}] ${text}`,
    level,
  };
}

function appendLog(prev: LogEntry[], entry: LogEntry): LogEntry[] {
  if (prev.length >= MAX_LOGS) {
    const next = prev.slice(1);
    next.push(entry);
    return next;
  }
  return [...prev, entry];
}

/** Rebuild a dedup Set to only contain timestamps present in the current logs. */
function pruneTimestampSet(logs: LogEntry[]): Set<number> {
  const keep = new Set<number>();
  for (const log of logs) {
    if (log.source === 'status') keep.add(log.timestamp);
  }
  return keep;
}

const levelColors: Record<LogEntry['level'], string> = {
  info: 'inherit',
  warn: '#ffa726',
  error: '#ef5350',
};

function highlightMatches(text: string, term: string): React.ReactNode {
  if (!term) return text;
  const lower = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let idx = lower.indexOf(lowerTerm);
  while (idx !== -1) {
    if (idx > lastIndex) parts.push(text.slice(lastIndex, idx));
    parts.push(
      <span key={idx} style={{ backgroundColor: 'rgba(255, 213, 79, 0.4)', borderRadius: 2 }}>
        {text.slice(idx, idx + term.length)}
      </span>,
    );
    lastIndex = idx + term.length;
    idx = lower.indexOf(lowerTerm, lastIndex);
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

// ── Memoized row ──────────────────────────────────────────────────────

const LogRow = memo(function LogRow({ log, searchTerm }: { log: LogEntry; searchTerm: string }) {
  const msgColor = levelColors[log.level];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingLeft: 12,
        paddingRight: 12,
        height: ROW_HEIGHT,
        borderBottom: '1px solid var(--log-border)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        color: msgColor,
      }}
    >
      <span style={{ color: 'var(--log-text-dim)', flexShrink: 0, width: '10ch', fontSize: '0.75rem' }}>
        {formatTime(log.timestamp)}
      </span>
      <span
        style={{
          flexShrink: 0,
          width: '3ch',
          textAlign: 'center',
          fontSize: '0.65rem',
          fontWeight: 700,
          color: log.source === 'status' ? '#66bb6a' : '#42a5f5',
          opacity: 0.85,
        }}
      >
        {log.source === 'status' ? 'STS' : 'RAD'}
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', fontSize: '0.78rem' }}>
        {highlightMatches(log.message, searchTerm)}
      </span>
    </div>
  );
});

// ── Main component ────────────────────────────────────────────────────

export function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showStatus, setShowStatus] = useState(true);
  const [showRadio, setShowRadio] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isAtBottom, setIsAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const historyTimestampsRef = useRef<Set<number>>(new Set());

  // scrollTop lives in a ref to avoid re-rendering on every scroll event.
  // A rAF-gated tick triggers re-renders at most once per frame.
  const scrollTopRef = useRef(0);
  const rafRef = useRef(0); // scroll-driven virtualization rAF
  const autoScrollRafRef = useRef(0); // auto-scroll-to-bottom rAF
  const [, setRenderTick] = useState(0);

  // ── Data ingestion ────────────────────────────────────────────────

  // Backfill history on mount — track timestamps to deduplicate against the
  // staggered useUpdateCallback dispatches from useBackend's processHistory.
  const history = useHistory();
  useEffect(() => {
    if (history.length === 0) return;

    const seen = historyTimestampsRef.current;
    const newEntries: LogEntry[] = [];

    for (const entry of history) {
      if (seen.has(entry.timestamp)) continue;
      seen.add(entry.timestamp);
      newEntries.push({ id: nextId++, ...statusEntryToLog(entry) });
    }

    if (newEntries.length === 0) return;

    setLogs(prev => {
      const merged = [...prev, ...newEntries];
      merged.sort((a, b) => a.timestamp - b.timestamp);
      if (merged.length > MAX_LOGS) return merged.slice(merged.length - MAX_LOGS);
      return merged;
    });
  }, [history]);

  useUpdateCallback(
    useCallback((entry: StatusEntry) => {
      if (historyTimestampsRef.current.has(entry.timestamp)) return;
      historyTimestampsRef.current.add(entry.timestamp);
      setLogs(prev => {
        const next = appendLog(prev, { id: nextId++, ...statusEntryToLog(entry) });
        if (historyTimestampsRef.current.size > MAX_LOGS * 2) {
          historyTimestampsRef.current = pruneTimestampSet(next);
        }
        return next;
      });
    }, []),
  );

  useRadioMessageCallback(
    useCallback((msg: RadioMessage) => {
      setLogs(prev => appendLog(prev, { id: nextId++, ...radioMessageToLog(msg) }));
    }, []),
  );

  // ── Filtering ─────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    // Short-circuit: no filtering needed
    if (showStatus && showRadio && !searchTerm) return logs;

    const lowerSearch = searchTerm.toLowerCase();
    return logs.filter(log => {
      if (log.source === 'status' && !showStatus) return false;
      if (log.source === 'radio' && !showRadio) return false;
      if (lowerSearch && !log.message.toLowerCase().includes(lowerSearch)) return false;
      return true;
    });
  }, [logs, showStatus, showRadio, searchTerm]);

  // ── Scroll management ─────────────────────────────────────────────

  // Auto-scroll to bottom when new logs arrive (after DOM update)
  useEffect(() => {
    if (!isAtBottomRef.current || !scrollRef.current) return;
    const el = scrollRef.current;
    cancelAnimationFrame(autoScrollRafRef.current);
    autoScrollRafRef.current = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [filtered]);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      isAtBottomRef.current = true;
      setIsAtBottom(true);
    }
  }, []);

  // ── Virtualization ────────────────────────────────────────────────

  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      for (const e of entries) setViewportHeight(e.contentRect.height);
    });
    observer.observe(el);
    setViewportHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  // Clean up pending rAFs on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      cancelAnimationFrame(autoScrollRafRef.current);
    };
  }, []);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.target as HTMLDivElement;
    scrollTopRef.current = el.scrollTop;

    // Update isAtBottom — only set state when the value actually changes
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD;
    if (isAtBottomRef.current !== atBottom) {
      isAtBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
    }

    // Coalesce virtualization re-renders to one per animation frame
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setRenderTick(n => n + 1);
    });
  }, []);

  const totalHeight = filtered.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTopRef.current / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(filtered.length, startIndex + visibleCount);
  const visibleItems = filtered.slice(startIndex, endIndex);
  const offsetY = startIndex * ROW_HEIGHT;

  // ── Render ────────────────────────────────────────────────────────

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', px: 2, py: 1.5 }}>
      {/* ── Toolbar ──────────────────────────────────────────────── */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1, flexShrink: 0, flexWrap: 'wrap' }}>
        <Typography variant="h5" sx={{ fontWeight: 700, mr: 1 }}>
          Logs
        </Typography>

        {/* Source filters */}
        <Chip
          label="Status"
          color="success"
          variant={showStatus ? 'filled' : 'outlined'}
          onClick={() => setShowStatus(s => !s)}
          size="small"
        />
        <Chip
          label="Radio"
          color="info"
          variant={showRadio ? 'filled' : 'outlined'}
          onClick={() => setShowRadio(s => !s)}
          size="small"
        />

        {/* Search */}
        <TextField
          size="small"
          placeholder="Filter\u2026"
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          slotProps={{
            input: {
              endAdornment: searchTerm ? (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setSearchTerm('')} edge="end">
                    <span style={{ fontSize: '1rem', lineHeight: 1 }}>{'\u00d7'}</span>
                  </IconButton>
                </InputAdornment>
              ) : undefined,
              sx: { fontFamily: 'monospace', fontSize: '0.85rem', height: 32 },
            },
          }}
          sx={{ ml: 'auto', width: 220 }}
        />

        {/* Entry count */}
        <Typography variant="body2" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
          {filtered.length === logs.length ? `${logs.length}` : `${filtered.length} / ${logs.length}`}
        </Typography>

        {/* Clear */}
        <Tooltip title="Clear all logs">
          <Chip
            label="Clear"
            variant="outlined"
            size="small"
            onDelete={() => {
              setLogs([]);
              historyTimestampsRef.current.clear();
            }}
          />
        </Tooltip>
      </Box>

      {/* ── Log viewport ─────────────────────────────────────────── */}
      <Box
        ref={scrollRef}
        onScroll={onScroll}
        sx={theme => ({
          flex: 1,
          overflow: 'auto',
          bgcolor: 'background.paper',
          borderRadius: 1,
          border: 1,
          borderColor: 'divider',
          fontFamily: 'monospace',
          position: 'relative',
          '--log-text-dim': theme.palette.text.secondary,
          '--log-border': theme.palette.divider,
        })}
      >
        <div style={{ height: totalHeight, position: 'relative' }}>
          <div style={{ position: 'absolute', top: offsetY, left: 0, right: 0 }}>
            {visibleItems.map(log => (
              <LogRow key={log.id} log={log} searchTerm={searchTerm} />
            ))}
          </div>
        </div>

        {filtered.length === 0 && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {logs.length === 0 ? 'Waiting for log data\u2026' : 'No matches'}
            </Typography>
          </Box>
        )}
      </Box>

      {/* ── Jump-to-bottom FAB ───────────────────────────────────── */}
      {!isAtBottom && (
        <Fab
          size="small"
          onClick={scrollToBottom}
          sx={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            bgcolor: 'primary.dark',
            '&:hover': { bgcolor: 'primary.main' },
          }}
        >
          <span style={{ fontSize: '1.2rem', lineHeight: 1 }}>{'\u2193'}</span>
        </Fab>
      )}
    </Box>
  );
}
