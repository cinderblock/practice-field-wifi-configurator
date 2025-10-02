import { StationName, TrustedProxyConfig } from './types.js';

export function capitalizeFirstLetter(string: string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

export function prettyStationName(station: StationName) {
  const match = station.match(/^(?<alliance>red|blue)(?<station>\d)$/);
  if (!match?.groups) {
    throw new Error(`Invalid station name: ${station}`);
  }

  const { alliance, station: stationNumber } = match.groups;

  return `${capitalizeFirstLetter(alliance)} ${stationNumber}`;
}

/**
 * Checks if an IP address is within a CIDR block
 */
function isIpInCidr(ip: string, cidr: string): boolean {
  // Handle simple IP match (no CIDR)
  if (!cidr.includes('/')) {
    return ip === cidr;
  }

  // Handle CIDR blocks
  const [network, prefixLength] = cidr.split('/');
  const prefix = parseInt(prefixLength, 10);

  if (isNaN(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  // Convert IPs to integers for comparison
  const ipToInt = (ip: string): number => {
    return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);
  };

  const ipInt = ipToInt(ip);
  const networkInt = ipToInt(network);
  const mask = (-1 << (32 - prefix)) >>> 0; // Unsigned right shift to handle negative numbers

  return (ipInt & mask) === (networkInt & mask);
}

/**
 * Checks if an IP address is in the list of trusted proxies
 */
function isTrustedProxy(clientIp: string, trustedProxies: string[]): boolean {
  return trustedProxies.some(proxy => isIpInCidr(clientIp, proxy));
}

/**
 * Extracts the real client IP from request headers, considering trusted proxies
 * @param socketRemoteAddress - The remote address from the socket
 * @param requestHeaders - The request headers object
 * @param trustedProxyConfig - Configuration for trusted proxies
 * @returns The real client IP address
 */
export function getRealClientIp(
  socketRemoteAddress: string | undefined,
  requestHeaders: Record<string, string | string[] | undefined>,
  trustedProxyConfig?: TrustedProxyConfig,
): string {
  // If no trusted proxy config, just return the socket remote address
  if (!trustedProxyConfig || trustedProxyConfig.proxies.length === 0) {
    return socketRemoteAddress || 'unknown';
  }

  // If the client IP is not a trusted proxy, return it as-is
  if (!socketRemoteAddress || !isTrustedProxy(socketRemoteAddress, trustedProxyConfig.proxies)) {
    return socketRemoteAddress || 'unknown';
  }

  // Extract real IP from headers (trusted proxy scenario)
  const forwardedFor = requestHeaders['x-forwarded-for'];
  const realIp = requestHeaders['x-real-ip'];
  const cfConnectingIp = requestHeaders['cf-connecting-ip']; // Cloudflare

  // Parse X-Forwarded-For (can contain multiple IPs, the first one is the original client)
  if (forwardedFor) {
    const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    const firstIp = ips.split(',')[0].trim();
    if (firstIp) {
      return firstIp;
    }
  }

  // Fall back to X-Real-IP
  if (realIp) {
    const ip = Array.isArray(realIp) ? realIp[0] : realIp;
    if (ip) {
      return ip;
    }
  }

  // Fall back to Cloudflare's CF-Connecting-IP
  if (cfConnectingIp) {
    const ip = Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp;
    if (ip) {
      return ip;
    }
  }

  // If we can't find the real IP in headers, return the socket address
  return socketRemoteAddress || 'unknown';
}
