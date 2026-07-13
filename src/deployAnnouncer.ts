import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';

const execFile = promisify(execFileCb);

const StateFile = process.env.DEPLOY_ANNOUNCE_FILE ?? 'deploy-announced.json';
const MAX_LISTED_CHANGES = 15;
const POST_RETRY_INTERVAL_MS = 10_000;
const POST_MAX_RETRIES = 18; // keep trying ~3 minutes while Slack connects after startup

function readLastAnnounced(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(StateFile, 'utf-8')) as { lastAnnounced?: unknown };
    return typeof parsed.lastAnnounced === 'string' ? parsed.lastAnnounced : null;
  } catch {
    return null;
  }
}

/**
 * On startup, post a change summary to the support Slack channel when the
 * running version differs from the last announced one. The changelog is the
 * commit subjects between the two versions — commit subjects in this repo are
 * written for the support-channel audience (see CLAUDE.md).
 *
 * The announced version is only persisted after a successful post, so if
 * Slack is down the announcement retries on the next restart. Plain service
 * restarts without a version change post nothing.
 */
export async function announceDeploy(post: (text: string) => Promise<boolean>): Promise<void> {
  let current: string;
  try {
    current = (await execFile('git', ['rev-parse', 'HEAD'])).stdout.trim();
  } catch {
    return; // not running from a git checkout — nothing to announce
  }
  if (!current) return;

  const last = readLastAnnounced();
  if (last === current) return;
  if (!last) {
    // First run with announcements enabled — record the baseline quietly.
    writeFileSync(StateFile, JSON.stringify({ lastAnnounced: current }, null, 2));
    return;
  }

  let subjects: string[] = [];
  try {
    const { stdout } = await execFile('git', ['log', '--format=%s', `${last}..${current}`]);
    subjects = stdout.split('\n').filter(Boolean).reverse(); // oldest first — reads like a story
  } catch {
    // Previous commit unknown locally (e.g. history rewrite) — announce without a list.
  }

  const short = (hash: string) => hash.slice(0, 7);
  let text: string;
  if (subjects.length === 0) {
    text = `:rocket: *pFMS updated* to \`${short(current)}\` (was \`${short(last)}\`).`;
  } else {
    const lines = subjects.slice(0, MAX_LISTED_CHANGES).map(s => `• ${s}`);
    if (subjects.length > MAX_LISTED_CHANGES) {
      lines.push(`…and ${subjects.length - MAX_LISTED_CHANGES} more`);
    }
    const plural = subjects.length === 1 ? 'change' : 'changes';
    text = [
      `:rocket: *pFMS updated* — ${subjects.length} ${plural} (\`${short(last)}\` → \`${short(current)}\`)`,
      ...lines,
    ].join('\n');
  }

  for (let attempt = 0; attempt < POST_MAX_RETRIES; attempt++) {
    if (await post(text)) {
      writeFileSync(StateFile, JSON.stringify({ lastAnnounced: current }, null, 2));
      console.log(`Deploy announcement posted (${subjects.length} change(s), ${short(last)} → ${short(current)})`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, POST_RETRY_INTERVAL_MS));
  }
  console.warn('Deploy announcement not posted (Slack unavailable) — will retry on next restart');
}
