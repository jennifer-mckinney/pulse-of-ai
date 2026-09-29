// src/collectors/adapters/blocked.js
// The 4 BLOCKED sources (ADR 0001 ruling 5): WeChat, Telegram, ResearchGate
// and Cato. Each class REFUSES to run unless its explicit official
// permission env is set — the base Collector constructor throws
// GateClosedError before any network call (the route's `requires`), and
// each class re-asserts it. With permission, only the intended official
// route is used. A 401/403 or bot challenge ends the run (AccessDeniedError
// in src/collectors/http.js): bot detection, CAPTCHAs, Incapsula and 403
// walls are never worked around.

'use strict';

const { RssAtomCollector, JsonApiCollector, BulkFileCollector } = require('../base');
const { GateClosedError } = require('../errors');

function assertPermission(collector, envName) {
    const v = collector.env[envName];
    if (typeof v !== 'string' || v.trim() === '') {
        throw new GateClosedError(`${collector.source.slug}: blocked — no compliant access without ${envName}`);
    }
}

/**
 * WeChat: only a feed Tencent authorizes in writing (never mp.weixin.qq.com
 * or Sogou). The feed URL must be https on a public host (F10-11) and on
 * EXACTLY the host the authorization names, WECHAT_AUTHORIZED_FEED_HOST
 * (G10-17) — a look-alike or a subdomain is refused.
 */
class WeChatAuthorizedFeedCollector extends RssAtomCollector {
    constructor(ctx) {
        super(ctx);
        assertPermission(this, 'WECHAT_TENCENT_AUTHORIZATION_REF');
        assertPermission(this, 'WECHAT_AUTHORIZED_FEED_HOST');
        const url = this.envUrl('WECHAT_AUTHORIZED_FEED_URL');
        const host = new URL(url).hostname.toLowerCase();
        const authorized = this.env.WECHAT_AUTHORIZED_FEED_HOST.trim().toLowerCase();
        if (host !== authorized) {
            throw new GateClosedError(`wechat: the feed host ${host} is not the authorized host ${authorized} (WECHAT_AUTHORIZED_FEED_HOST)`);
        }
        if (/(^|\.)weixin\.qq\.com\/s|weixin\.sogou\.com/i.test(url)) {
            throw new GateClosedError('wechat: article pages and Sogou WeChat search are disallowed by robots.txt — not a feed');
        }
        this.feedUrl = url;
    }

    feedUrls() {
        return [this.feedUrl];
    }
}

/** Telegram: official Bot API channel_post updates, only under Telegram's written permission. */
class TelegramBotApiCollector extends JsonApiCollector {
    constructor(ctx) {
        super(ctx);
        assertPermission(this, 'TELEGRAM_WRITTEN_PERMISSION_REF');
    }

    async fetchItems() {
        const q = new URLSearchParams({ allowed_updates: JSON.stringify(['channel_post']), timeout: '0' });
        if (this.cursor.offset) q.set('offset', String(this.cursor.offset));
        const res = await this.getJson(`https://api.telegram.org/bot${this.envValue('TELEGRAM_BOT_TOKEN')}/getUpdates?${q}`);
        const updates = res.data.result || [];
        if (updates.length) this.cursor.offset = Math.max(...updates.map(u => u.update_id)) + 1;
        // Channel titles and sender fields are not mapped.
        return updates.filter(u => u.channel_post && u.channel_post.text).map(u => ({
            id: `${u.channel_post.chat.id}:${u.channel_post.message_id}`,
            title: '', text: u.channel_post.text, url: null, publishedAt: u.channel_post.date,
        }));
    }
}

/** ResearchGate: only a dataset delivered under a data-access grant; never the website. */
class ResearchGateGrantedDatasetCollector extends BulkFileCollector {
    constructor(ctx) {
        super(ctx);
        assertPermission(this, 'RESEARCHGATE_DATA_ACCESS_REF');
    }

    get pathEnv() { return 'RESEARCHGATE_DATASET_PATH'; }
}

/** Cato: its own RSS, only once Cato allowlists the collector User-Agent. */
class CatoAllowlistedRssCollector extends RssAtomCollector {
    constructor(ctx) {
        super(ctx);
        assertPermission(this, 'CATO_ALLOWLIST_REF');
    }
}

module.exports = {
    WeChatAuthorizedFeedCollector, TelegramBotApiCollector,
    ResearchGateGrantedDatasetCollector, CatoAllowlistedRssCollector, assertPermission,
};
