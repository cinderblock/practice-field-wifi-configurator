import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import { useUsageState } from '../hooks/useBackend';
import { UsageSession } from '../../../src/types';
import { TeamAvatar } from './TeamAvatar';

// ── Helpers ─────────────────────────────────────────────────────────

function formatHours(ms: number): string {
  const hours = ms / (1000 * 60 * 60);
  if (hours < 0.1) return `${Math.round(ms / 60_000)}m`;
  return `${hours.toFixed(1)}h`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Get the date key (YYYY-MM-DD) for a timestamp in local timezone. */
function dateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface TeamUsage {
  team: number;
  /** Total field time in ms (union of overlapping sessions — same team on multiple stations). */
  fieldTimeMs: number;
  /** Total robot-hours (sum of all sessions, counts each robot/station separately). */
  robotHoursMs: number;
  /** Number of sessions. */
  sessionCount: number;
  /** Number of distinct stations used. */
  stationCount: number;
  /** First seen timestamp. */
  firstSeen: number;
  /** Last seen timestamp. */
  lastSeen: number;
  /** Whether a session is still active. */
  active: boolean;
}

interface DailySummary {
  date: string;
  dateLabel: string;
  /** Total field time (any team connected). */
  fieldTimeMs: number;
  /** Unique teams. */
  teamCount: number;
  teams: TeamUsage[];
}

// ── Computation ─────────────────────────────────────────────────────

/** Merge overlapping time ranges and return the total duration. */
function unionDuration(ranges: [number, number][]): number {
  if (ranges.length === 0) return 0;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, end] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][0] <= end) {
      end = Math.max(end, sorted[i][1]);
    } else {
      total += end - start;
      [start, end] = sorted[i];
    }
  }
  total += end - start;
  return total;
}

function computeTeamUsage(sessions: UsageSession[]): TeamUsage[] {
  const byTeam = new Map<number, UsageSession[]>();
  for (const s of sessions) {
    const list = byTeam.get(s.team) ?? [];
    list.push(s);
    byTeam.set(s.team, list);
  }

  const results: TeamUsage[] = [];
  for (const [team, teamSessions] of byTeam) {
    const ranges: [number, number][] = teamSessions.map(s => [s.startedAt, s.endedAt ?? s.lastSeenAt]);
    const stations = new Set(teamSessions.map(s => s.station));

    results.push({
      team,
      fieldTimeMs: unionDuration(ranges),
      robotHoursMs: teamSessions.reduce((sum, s) => sum + ((s.endedAt ?? s.lastSeenAt) - s.startedAt), 0),
      sessionCount: teamSessions.length,
      stationCount: stations.size,
      firstSeen: Math.min(...teamSessions.map(s => s.startedAt)),
      lastSeen: Math.max(...teamSessions.map(s => s.endedAt ?? s.lastSeenAt)),
      active: teamSessions.some(s => s.endedAt === null),
    });
  }

  return results.sort((a, b) => b.fieldTimeMs - a.fieldTimeMs);
}

function computeDailySummaries(sessions: UsageSession[]): DailySummary[] {
  const byDate = new Map<string, UsageSession[]>();

  for (const s of sessions) {
    const key = dateKey(s.startedAt);
    const list = byDate.get(key) ?? [];
    list.push(s);
    byDate.set(key, list);
  }

  const summaries: DailySummary[] = [];
  for (const [date, daySessions] of byDate) {
    const teams = computeTeamUsage(daySessions);
    const allRanges: [number, number][] = daySessions.map(s => [s.startedAt, s.endedAt ?? s.lastSeenAt]);

    summaries.push({
      date,
      dateLabel: formatDate(daySessions[0].startedAt),
      fieldTimeMs: unionDuration(allRanges),
      teamCount: teams.length,
      teams,
    });
  }

  return summaries.sort((a, b) => b.date.localeCompare(a.date));
}

// ── Components ──────────────────────────────────────────────────────

export function UsagePage() {
  const usageState = useUsageState();

  const { allTeams, dailySummaries, totalFieldTime, totalRobotHours } = useMemo(() => {
    const sessions = usageState?.sessions ?? [];
    const allTeams = computeTeamUsage(sessions);
    const dailySummaries = computeDailySummaries(sessions);
    const allRanges: [number, number][] = sessions.map(s => [s.startedAt, s.endedAt ?? s.lastSeenAt]);
    const totalFieldTime = unionDuration(allRanges);
    const totalRobotHours = sessions.reduce((sum, s) => sum + ((s.endedAt ?? s.lastSeenAt) - s.startedAt), 0);
    return { allTeams, dailySummaries, totalFieldTime, totalRobotHours };
  }, [usageState]);

  if (!usageState) {
    return (
      <Container maxWidth="md" sx={{ py: 4 }}>
        <Typography variant="h4" sx={{ mb: 2, fontWeight: 700 }}>
          Field Usage
        </Typography>
        <Typography color="text.secondary">Connecting...</Typography>
      </Container>
    );
  }

  const sessionCount = usageState.sessions.length;
  const activeSessions = usageState.sessions.filter(s => s.endedAt === null).length;

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Typography variant="h4" sx={{ mb: 3, fontWeight: 700 }}>
        Field Usage
      </Typography>

      {/* Summary stats */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 2, mb: 3 }}>
        <StatCard label="Total Field Time" value={formatHours(totalFieldTime)} />
        <StatCard label="Robot Hours" value={formatHours(totalRobotHours)} />
        <StatCard label="Teams" value={String(allTeams.length)} />
        <StatCard label="Sessions" value={String(sessionCount)} />
        {activeSessions > 0 && <StatCard label="Active Now" value={String(activeSessions)} highlight />}
      </Box>

      {/* Per-team breakdown */}
      {allTeams.length > 0 && (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 2 }}>
              Team Breakdown
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {allTeams.map(t => (
                <TeamUsageRow key={t.team} usage={t} maxFieldTime={allTeams[0].fieldTimeMs} />
              ))}
            </Box>
          </CardContent>
        </Card>
      )}

      {/* Daily summaries */}
      {dailySummaries.length > 0 && (
        <Card>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 2 }}>
              Daily Breakdown
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {dailySummaries.map(day => (
                <DaySection key={day.date} day={day} />
              ))}
            </Box>
          </CardContent>
        </Card>
      )}

      {sessionCount === 0 && (
        <Card>
          <CardContent sx={{ textAlign: 'center', py: 4 }}>
            <Typography color="text.secondary">No usage data yet. Sessions are recorded when teams connect.</Typography>
          </CardContent>
        </Card>
      )}
    </Container>
  );
}

function StatCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <Card
      sx={{
        textAlign: 'center',
        ...(highlight && { borderColor: 'success.main', borderWidth: 2 }),
      }}
      variant="outlined"
    >
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Typography variant="h5" sx={{ fontWeight: 700, ...(highlight && { color: 'success.main' }) }}>
          {value}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
      </CardContent>
    </Card>
  );
}

function TeamUsageRow({ usage, maxFieldTime }: { usage: TeamUsage; maxFieldTime: number }) {
  const barWidth = maxFieldTime > 0 ? (usage.fieldTimeMs / maxFieldTime) * 100 : 0;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 80 }}>
        <TeamAvatar teamNumber={usage.team} size={20} />
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {usage.team}
        </Typography>
        {usage.active && (
          <Chip
            label="active"
            size="small"
            color="success"
            variant="outlined"
            sx={{ height: 18, fontSize: '0.6rem' }}
          />
        )}
      </Box>
      <Box
        sx={{ flex: 1, position: 'relative', height: 24, borderRadius: 1, overflow: 'hidden', bgcolor: 'action.hover' }}
      >
        <Box
          sx={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${barWidth}%`,
            bgcolor: usage.active ? 'success.main' : 'primary.main',
            opacity: 0.7,
            borderRadius: 1,
            transition: 'width 0.3s ease',
          }}
        />
        <Box
          sx={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            height: '100%',
            px: 1,
            gap: 1,
          }}
        >
          <Typography variant="caption" sx={{ fontWeight: 600 }}>
            {formatHours(usage.fieldTimeMs)}
          </Typography>
          {usage.robotHoursMs !== usage.fieldTimeMs && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              ({formatHours(usage.robotHoursMs)} robot hrs)
            </Typography>
          )}
          <Typography variant="caption" sx={{ color: 'text.secondary', ml: 'auto' }}>
            {usage.sessionCount} session{usage.sessionCount !== 1 ? 's' : ''}
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}

function DaySection({ day }: { day: DailySummary }) {
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          {day.dateLabel}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Chip label={`${day.teamCount} teams`} size="small" variant="outlined" />
          <Chip label={formatHours(day.fieldTimeMs)} size="small" color="primary" variant="outlined" />
        </Box>
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, pl: 1 }}>
        {day.teams.map(t => (
          <Box key={t.team} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <TeamAvatar teamNumber={t.team} size={16} />
            <Typography variant="body2" sx={{ fontWeight: 500, minWidth: 50 }}>
              {t.team}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {formatHours(t.fieldTimeMs)}
              {t.sessionCount > 1 && ` (${t.sessionCount} sessions)`}
            </Typography>
            {t.active && (
              <Chip
                label="active"
                size="small"
                color="success"
                variant="outlined"
                sx={{ height: 16, fontSize: '0.55rem' }}
              />
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
