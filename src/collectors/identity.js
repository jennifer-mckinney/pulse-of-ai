// src/collectors/identity.js
// Identity-bearing links and in-text identities (ingest@1.3.0, decision D2):
// what must not be stored because it points at, or names, a person.
//
//   isIdentityUrl(url)    a link whose path (or host) is a person's profile or
//                         user namespace: /user/<x>, /u/<x>, /profile/<x>,
//                         /people/, /member(s)/, /@<x>, github.com/<user>,
//                         gitlab.com/<user>, x.com / twitter.com /<handle>,
//                         linkedin.com/in/<x>, medium.com/<x>, the root of a
//                         <name>.substack.com, facebook.com/<x>,
//                         instagram.com/<x>, t.me/<x>, youtube.com /c/ and
//                         /channel/, Wikipedia User: / User talk: /
//                         Special:Contributions pages.
//   redactText(text)      in the text: e-mail addresses → [email], @handles →
//                         @[user], phone numbers (E.164, NANP) → [phone],
//                         identity links → [profile link], "cc <Name>" →
//                         "cc [name]", Wikipedia "Preceding unsigned comment
//                         added by …" → removed, and a trailing sign-off
//                         ("— Jane Doe") → removed.
//
// Every pattern is bounded and linear (F10-3); inputs are already capped.

'use strict';

const PATH_IDENTITY_RE = /\/(?:user|users|u|profile|people|member|members)\/[^/?#]+|\/@[^/?#]+/i;
const WIKI_USER_RE = /\/wiki\/(?:User(?:_talk)?:|Special:Contributions\/)/i;

// Hosts whose FIRST path segment is an account (unless it is one of the
// site's own sections).
const ACCOUNT_HOSTS = Object.freeze({
    'github.com': ['about', 'features', 'topics', 'collections', 'trending', 'marketplace', 'orgs', 'sponsors', 'search', 'settings', 'blog', 'enterprise', 'pricing', 'security', 'site', 'apps'],
    'gitlab.com': ['explore', 'help', 'users', 'groups', 'projects', 'search', 'dashboard'],
    'x.com': ['i', 'home', 'search', 'explore', 'hashtag', 'settings', 'intent', 'share', 'tos', 'privacy'],
    'twitter.com': ['i', 'home', 'search', 'explore', 'hashtag', 'settings', 'intent', 'share', 'tos', 'privacy'],
    'medium.com': ['tag', 'topic', 'search', 'about', 'membership', 'plans', 'm', 'p'],
    'facebook.com': ['groups', 'events', 'pages', 'watch', 'help', 'policies', 'privacy', 'legal'],
    'instagram.com': ['p', 'reel', 'reels', 'explore', 'about', 'legal', 'accounts'],
    't.me': ['s', 'addstickers', 'share', 'joinchat', 'iv'],
});

/**
 * @param {string} url
 * @returns {boolean} true when the link identifies a person
 */
function isIdentityUrl(url) {
    let u;
    try {
        u = new URL(String(url));
    } catch {
        return PATH_IDENTITY_RE.test(String(url));
    }
    const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
    const path = u.pathname;
    if (PATH_IDENTITY_RE.test(path) || WIKI_USER_RE.test(path)) return true;
    const segs = path.split('/').filter(Boolean);
    if (host === 'linkedin.com' && segs[0] === 'in') return true;
    if (host === 'youtube.com' && ['c', 'channel'].includes(segs[0])) return true;
    // A newsletter's own subdomain root (the author's page), not its posts.
    if (/\.substack\.com$/.test(host) && (segs.length === 0 || segs[0] === 'about')) return true;
    const reserved = ACCOUNT_HOSTS[host];
    if (reserved && segs.length >= 1 && !reserved.includes(segs[0].toLowerCase())) {
        // github.com/<user> or gitlab.com/<user> is a profile; <user>/<repo>
        // is a repository (kept). Social hosts: any /<handle>/... is personal.
        if (host === 'github.com' || host === 'gitlab.com') return segs.length === 1;
        return true;
    }
    return false;
}

const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z])/g;
const HANDLE_RE = /(^|[^A-Za-z0-9_.])@[A-Za-z0-9_][A-Za-z0-9_.-]{1,38}/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]{1,2048}/gi;
// E.164 (+ and 7–15 digits, optional single separators) and NANP
// ((NXX) NXX-XXXX with optional +1). Digits on either side block a match.
const E164_RE = /(?<![\w+])\+[1-9](?:[ .-]?\d){6,14}(?!\d)/g;
const NANP_RE = /(?<![\w+])(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[ .-]?[2-9]\d{2}[ .-]?\d{4}(?!\d)/g;
const CC_RE = /(^|\s)([Cc][Cc]):?[ \t]{1,4}(?:@\[user\]|[A-Z][a-z]{1,20}(?:[ \t][A-Z][a-z]{1,20}){0,2})/g;
// Wikipedia's {{unsigned}} note always closes a comment: everything from
// "(Preceding) unsigned comment added by" to the end of the line goes
// (the name or IP, "(talk)", "(contribs)" and the timestamp), bounded.
const UNSIGNED_RE = /[—–-]{0,2}\s{0,3}(?:Preceding\s)?unsigned comment added by\b[^\n]{0,200}/gi;
const SIGNOFF_RE = /(?:^|\s)[—–]{1,2}\s{0,3}[A-Z][a-z]{1,20}(?:\s[A-Z][a-z]{1,20}){0,2}\.?\s{0,8}$/;

/**
 * In-text identity redaction (ingest@1.3.0).
 * @param {string} text
 * @returns {string}
 */
function redactText(text) {
    return String(text || '')
        .replace(URL_RE, m => (isIdentityUrl(m) ? '[profile link]' : m))
        .replace(EMAIL_RE, '[email]')
        .replace(HANDLE_RE, '$1@[user]')
        .replace(E164_RE, '[phone]')
        .replace(NANP_RE, '[phone]')
        .replace(UNSIGNED_RE, ' ')
        .replace(CC_RE, '$1$2 [name]')
        .replace(SIGNOFF_RE, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

module.exports = { isIdentityUrl, redactText, EMAIL_RE, HANDLE_RE, PATH_IDENTITY_RE };
