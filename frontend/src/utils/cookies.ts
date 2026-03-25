const COOKIE_NAME = 'team';
const MAX_AGE = 7776000; // 90 days in seconds

export function getTeamNumberCookie(): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function setTeamNumberCookie(teamNumber: string): void {
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(teamNumber)};path=/;max-age=${MAX_AGE};SameSite=Lax`;
}

export function clearTeamNumberCookie(): void {
  document.cookie = `${COOKIE_NAME}=;path=/;max-age=0`;
}
