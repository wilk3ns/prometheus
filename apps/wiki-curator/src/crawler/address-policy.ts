import { BlockList, isIP } from 'node:net';

/**
 * Non-public address ranges the crawler must never connect to (SSRF guard, ENG-T1 §3 rule 1). Covers the
 * ranges named in the spec plus the other IANA special-purpose blocks that are equally unroutable/internal.
 * IPv6 transition/translation prefixes (6to4, NAT64, IPv4-translated, Teredo, IPv4-compatible) are blocked
 * outright: each can carry an attacker-chosen IPv4 (e.g. 169.254.169.254) through a relay or translator.
 * IPv4-mapped addresses (`::ffff:a.b.c.d`) are decoded and judged by the IPv4 table.
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local incl. 169.254.169.254 cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback (::1) and deprecated IPv4-compatible ::a.b.c.d
  ['::ffff:0:0:0', 96], // IPv4-translated (SIIT)
  ['64:ff9b::', 96], // NAT64 well-known prefix
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** Embedded IPv4 of an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` or `::ffff:7f00:1`), else undefined. */
function mappedIpv4(address: string): string | undefined {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (dotted?.[1]) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return undefined;
}

/** True when `address` (an IP literal) is loopback/private/link-local/reserved. Non-IPs are rejected too. */
export function isNonPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) {
    const v4 = mappedIpv4(ip);
    return v4 !== undefined ? blocked.check(v4, 'ipv4') : blocked.check(ip, 'ipv6');
  }
  return true;
}

/**
 * Which hostnames may resolve to non-public addresses. Empty everywhere except INFRA_PROFILE=local with
 * ALLOW_LOCAL_FIXTURE_HOSTS=true, where it holds only the named fixture host(s): every other host, including
 * live official sites crawled in the same process, keeps the full private-IP block. IP literals are never
 * exempt.
 */
export interface AddressPolicy {
  readonly nonPublicAllowedHosts: ReadonlySet<string>;
}

export const STRICT_ADDRESS_POLICY: AddressPolicy = { nonPublicAllowedHosts: new Set() };

export function isAddressPermitted(policy: AddressPolicy, address: string, hostname: string): boolean {
  if (!isNonPublicAddress(address)) return true;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return isIP(host.replace(/^\[|\]$/g, '')) === 0 && policy.nonPublicAllowedHosts.has(host);
}
