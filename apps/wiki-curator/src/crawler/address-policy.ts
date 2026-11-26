import { BlockList, isIP } from 'node:net';

/**
 * Non-public address ranges the crawler must never connect to (SSRF guard, ENG-T1 §3 rule 1). Covers the
 * ranges named in the spec plus the other IANA special-purpose blocks that are equally unroutable/internal.
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
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['64:ff9b:1::', 48], // local-use NAT64
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** Embedded IPv4 of IPv4-mapped (`::ffff:a.b.c.d`) or IPv4-compatible IPv6 forms, else undefined. */
function embeddedIpv4(address: string): string | undefined {
  const m = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (m?.[1]) return m[1];
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
    const v4 = embeddedIpv4(ip);
    return v4 !== undefined ? blocked.check(v4, 'ipv4') : blocked.check(ip, 'ipv6');
  }
  return true;
}

export interface AddressPolicy {
  /** Only true in INFRA_PROFILE=local with ALLOW_LOCAL_FIXTURE_HOSTS=true. */
  readonly allowNonPublic: boolean;
}

export function isAddressPermitted(policy: AddressPolicy, address: string): boolean {
  return policy.allowNonPublic || !isNonPublicAddress(address);
}
