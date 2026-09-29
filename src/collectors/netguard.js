// src/collectors/netguard.js
// Where a collector may connect (F10-2): SSRF and credential-exfiltration
// guards for every request and every redirect hop.
//
//   checkUrl(url, { allowedHosts })   https only; no single-label host (the
//        compose service names postgres / redis / web / embeddings / ... are
//        single-label), no *.localhost / *.local / *.internal; an IP literal
//        must be a public address; when allowedHosts is given the host must
//        be one of them (a leading "www." is ignored both ways). Throws
//        HostRefusedError.
//   isBlockedAddress(ip)              loopback, link-local, RFC 1918, CGNAT
//        (100.64/10), ULA (fc00::/7), 0.0.0.0/8, unspecified, multicast,
//        broadcast, and IPv4-mapped / NAT64 forms of any of them.
//   createGuardedLookup(dnsLookup)    a net/tls `lookup` that resolves every
//        address of the host and refuses the connection when ANY is blocked;
//        the socket then connects to the address this lookup returned, so a
//        DNS answer cannot change between the check and the connect (no
//        rebinding window).
//   hostAllowed(host, allowedHosts)   the allowlist comparison.

'use strict';

const dns = require('dns');
const net = require('net');
const { CollectorError } = require('./errors');

class HostRefusedError extends CollectorError {
    constructor(message, details = {}) {
        super(message, { kind: 'host_refused', ...details });
    }
}

class RedirectRefusedError extends CollectorError {
    constructor(message, details = {}) {
        super(message, { kind: 'redirect_refused', ...details });
    }
}

const BLOCKED_SUFFIX_RE = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

// Every range a collector must never reach. net.BlockList applies the IPv4
// rules to IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) as well.
const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
    ['0.0.0.0', 8],        // "this network", incl. unspecified
    ['10.0.0.0', 8],       // RFC 1918
    ['100.64.0.0', 10],    // CGNAT
    ['127.0.0.0', 8],      // loopback
    ['169.254.0.0', 16],   // link-local (cloud metadata endpoints)
    ['172.16.0.0', 12],    // RFC 1918
    ['192.0.0.0', 24],     // IETF protocol assignments
    ['192.168.0.0', 16],   // RFC 1918
    ['198.18.0.0', 15],    // benchmarking
    ['224.0.0.0', 4],      // multicast
    ['240.0.0.0', 4],      // reserved + broadcast
]) BLOCKED.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
    ['::', 96],            // unspecified, loopback ::1, IPv4-compatible
    ['64:ff9b::', 96],     // NAT64 (embeds an IPv4 address)
    ['64:ff9b:1::', 48],   // local-use NAT64
    ['fc00::', 7],         // ULA
    ['fe80::', 10],        // link-local
    ['ff00::', 8],         // multicast
]) BLOCKED.addSubnet(addr, prefix, 'ipv6');

/**
 * @param {string} ip  an IPv4 or IPv6 literal
 * @returns {boolean} true when a collector must never connect to it
 */
function isBlockedAddress(ip) {
    const addr = String(ip).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    const kind = net.isIP(addr);
    if (kind === 0) return true;                       // not an IP at all: refuse
    return BLOCKED.check(addr, kind === 4 ? 'ipv4' : 'ipv6');
}

const stripWww = h => String(h).toLowerCase().replace(/^www\./, '');

/** Whether `host` is on the allowlist (a leading "www." is ignored both ways). */
function hostAllowed(host, allowedHosts) {
    const h = stripWww(host);
    return allowedHosts.some(a => stripWww(a) === h);
}

/**
 * @param {string} url
 * @param {{ allowedHosts?: string[] }} [opts]
 * @returns {URL}
 * @throws {HostRefusedError}
 */
function checkUrl(url, { allowedHosts } = {}) {
    let u;
    try {
        u = new URL(url);
    } catch {
        throw new HostRefusedError('refused: not a URL');
    }
    if (u.protocol !== 'https:') throw new HostRefusedError(`refused: ${u.protocol.replace(':', '')} is not https (${u.host})`);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) {
        if (isBlockedAddress(host)) throw new HostRefusedError(`refused: ${host} is not a public address`);
    } else if (!host.includes('.') || BLOCKED_SUFFIX_RE.test(host)) {
        throw new HostRefusedError(`refused: ${host} is a local or internal host name`);
    }
    if (allowedHosts && !hostAllowed(host, allowedHosts)) {
        throw new HostRefusedError(`refused: ${host} is not an allowed host of this source`);
    }
    return u;
}

/**
 * A `lookup` for https.request: every resolved address must be public.
 * @param {Function} [dnsLookup] dns.lookup-compatible (tests inject a fake)
 */
function createGuardedLookup(dnsLookup = dns.lookup) {
    return function guardedLookup(hostname, options, callback) {
        const cb = typeof options === 'function' ? options : callback;
        const opts = typeof options === 'object' && options ? options : {};
        dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
            if (err) return cb(err);
            const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
            if (list.length === 0) return cb(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }));
            const bad = list.find(a => isBlockedAddress(a.address));
            if (bad) return cb(new HostRefusedError(`refused: ${hostname} resolves to ${bad.address}, not a public address`));
            // Node >= 20 may ask for all addresses (autoSelectFamily).
            if (opts.all) return cb(null, list);
            return cb(null, list[0].address, list[0].family);
        });
    };
}

module.exports = {
    checkUrl, isBlockedAddress, hostAllowed, createGuardedLookup, HostRefusedError, RedirectRefusedError,
};
