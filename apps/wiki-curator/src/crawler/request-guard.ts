import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { type AddressPolicy, isAddressPermitted, type LocalExemption } from './address-policy.js';
import type { DomainAllowlist } from './allowlist.js';

export type GuardDecision = 'OK' | 'DISALLOWED_HOST' | 'BLOCKED_PRIVATE_ADDRESS' | 'DNS_FAILURE';

export const BLOCKED_ADDRESS_ERROR_CODE = 'ERR_PROMETHEUS_BLOCKED_ADDRESS';

export class BlockedAddressError extends Error {
  override readonly name = 'BlockedAddressError';
  readonly code = BLOCKED_ADDRESS_ERROR_CODE;
  constructor(readonly hostname: string) {
    super(`refusing to connect: ${hostname} resolves to a non-public address`);
  }
}

export type Resolver = (hostname: string) => Promise<readonly string[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses: LookupAddress[]) => {
      if (error) reject(error);
      else resolve(addresses.map((a) => a.address));
    });
  });

/**
 * Per-request / per-hop policy: (1) host must be on the official allowlist, (2) every resolved address must
 * be public unless the hostname is an explicitly exempted local fixture host. `connectLookup` re-applies
 * (2) at socket connect time so a DNS answer that changes between check and connect (rebinding) is still
 * refused. IP-literal URLs never reach a lookup, so the pre-check (deterministic, no DNS) is final for them.
 */
export class RequestGuard {
  constructor(
    private readonly allowlist: DomainAllowlist,
    readonly addressPolicy: AddressPolicy,
    private readonly resolve: Resolver = systemResolver,
  ) {}

  async check(url: URL, exemption: LocalExemption): Promise<GuardDecision> {
    if (!this.allowlist.allows(url)) return 'DISALLOWED_HOST';
    return this.checkAddressOnly(url, exemption);
  }

  /** True when `hostname` is one of the configured local fixture hosts. */
  isExemptHost(hostname: string): boolean {
    return this.addressPolicy.nonPublicAllowedHosts.has(hostname.toLowerCase().replace(/\.$/, ''));
  }

  /** Address-only check for browser sub-resources (third-party CDNs allowed, internal networks never). */
  async checkAddressOnly(url: URL, exemption: LocalExemption): Promise<GuardDecision> {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) !== 0)
      return isAddressPermitted(this.addressPolicy, host, host, exemption) ? 'OK' : 'BLOCKED_PRIVATE_ADDRESS';
    let addresses: readonly string[];
    try {
      addresses = await this.resolve(host);
    } catch {
      return 'DNS_FAILURE';
    }
    if (addresses.length === 0) return 'DNS_FAILURE';
    return addresses.every((a) => isAddressPermitted(this.addressPolicy, a, host, exemption))
      ? 'OK'
      : 'BLOCKED_PRIVATE_ADDRESS';
  }

  /**
   * `lookup` for net/tls sockets: resolves, then fails closed if any address is not permitted under the
   * given exemption. Each exemption mode gets its own undici dispatcher, so the connect-time check always
   * matches the pre-check of the request that opened the socket.
   */
  connectLookup(exemption: LocalExemption): LookupFunction {
    return (hostname, options, callback) => {
      dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
        if (error) {
          callback(error, '', 0);
          return;
        }
        if (
          addresses.length === 0 ||
          !addresses.every((a) => isAddressPermitted(this.addressPolicy, a.address, hostname, exemption))
        ) {
          callback(new BlockedAddressError(hostname), '', 0);
          return;
        }
        if (options.all === true) {
          callback(null, addresses);
          return;
        }
        const first = addresses[0] as LookupAddress;
        callback(null, first.address, first.family);
      });
    };
  }
}
