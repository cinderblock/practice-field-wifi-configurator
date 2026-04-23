// Fetches and caches team avatars from the FIRST Events API.

import FRC from 'first-events-api';

const CURRENT_YEAR = new Date().getFullYear();

const username = process.env.FIRST_API_USERNAME;
const auth = process.env.FIRST_API_AUTH_TOKEN;

const frc =
  username && auth
    ? FRC({
        username,
        auth,
        season: CURRENT_YEAR,
      })
    : undefined;

if (!frc) {
  console.log('FIRST_API_USERNAME or FIRST_API_AUTH_TOKEN not set — team avatars disabled');
}

// Rate limiting: 1 request per second
const RATE_LIMIT_MS = 1000;
// Cache non-existent logos for 1 hour
const NON_EXISTENT_CACHE_MS = 60 * 60 * 1000;
// Refresh known avatars daily
const AVATAR_REFRESH_MS = 24 * 60 * 60 * 1000;

const avatarCache = new Map<number, { avatar: Buffer | undefined; timestamp: number }>();
const inFlightRequests = new Map<number, Promise<Buffer | undefined>>();
let lastRequestTime = 0;

async function rateLimit(): Promise<void> {
  while (true) {
    const timeSinceLastRequest = Date.now() - lastRequestTime;
    if (timeSinceLastRequest < RATE_LIMIT_MS) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - timeSinceLastRequest));
    } else break;
  }
  lastRequestTime = Date.now();
}

async function fetchAvatarFromAPI(team: number): Promise<Buffer | undefined> {
  if (!frc) return undefined;

  await rateLimit();

  const r = await frc.season.getTeamAvatarListings('', team).catch(() => undefined);

  if (r?.statusCode !== 200) return undefined;

  if (r.data.teamCountTotal > 1) {
    console.log(new Error(`Expected 1 avatar for team ${team}, got ${r.data.teamCountTotal}`));
    return undefined;
  }

  const avatar = r.data.teams[0]?.encodedAvatar;
  if (!avatar) return undefined;

  return Buffer.from(avatar, 'base64');
}

export async function getTeamAvatar(team: number): Promise<Buffer | undefined> {
  if (!frc) return undefined;

  // Deduplicate concurrent requests for the same team
  const inFlight = inFlightRequests.get(team);
  if (inFlight) return inFlight;

  const cached = avatarCache.get(team);

  if (cached) {
    const delta = Date.now() - cached.timestamp;
    if (cached.avatar === undefined) {
      if (delta < NON_EXISTENT_CACHE_MS) return undefined;
    } else if (delta <= AVATAR_REFRESH_MS) return cached.avatar;
  }

  const avatarBuffer = fetchAvatarFromAPI(team);
  avatarBuffer.then(avatar => {
    avatarCache.set(team, { avatar, timestamp: Date.now() });
    inFlightRequests.delete(team);
  });

  inFlightRequests.set(team, avatarBuffer);

  // Optimistically return stale cached avatar while refreshing
  return cached?.avatar ?? avatarBuffer;
}
