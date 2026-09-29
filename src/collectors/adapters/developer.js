// src/collectors/adapters/developer.js
// Developer-platform adapters: GitHub search, GitLab topic projects, Docker
// Hub namespace, Hugging Face daily papers, and Discourse forums (also used
// by OpenStreetMap). User namespaces are identities: owners, logins and
// avatar fields are never mapped, and links that embed a user namespace are
// not stored.

'use strict';

const { JsonApiCollector } = require('../base');

class GithubSearchCollector extends JsonApiCollector {
    async fetchItems() {
        const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
        if (this.envValue('GITHUB_TOKEN')) headers.Authorization = `Bearer ${this.envValue('GITHUB_TOKEN')}`;
        let q = this.params.q;
        if (this.params.createdWithinHours) {
            q += ` created:>${new Date(this.now() - this.params.createdWithinHours * 3600000).toISOString().slice(0, 19)}Z`;
        }
        const qs = new URLSearchParams({ q, sort: this.params.sort, order: 'desc', per_page: '30' });
        const res = await this.getJson(`https://api.github.com/search/${this.params.kind}?${qs}`, { headers });
        return (res.data.items || []).map((it) => {
            if (this.params.kind === 'repositories') {
                return { id: it.id, title: it.name, text: it.description || '', url: null, publishedAt: it.pushed_at || it.updated_at };
            }
            return { id: it.id, title: it.title, text: it.body || '', url: null, publishedAt: it.created_at };
        });
    }
}

class GitlabProjectsCollector extends JsonApiCollector {
    async fetchItems() {
        const headers = {};
        if (this.envValue('GITLAB_TOKEN')) headers['PRIVATE-TOKEN'] = this.envValue('GITLAB_TOKEN');
        const q = new URLSearchParams({
            topic: this.params.topic, order_by: 'last_activity_at', sort: 'desc',
            per_page: String(this.params.perPage || 20), simple: 'true',
        });
        const res = await this.getJson(`https://gitlab.com/api/v4/projects?${q}`, { headers });
        return (res.data || []).map(p => ({
            id: p.id, title: p.name, text: p.description || '', url: null, publishedAt: p.last_activity_at,
        }));
    }
}

class DockerHubNamespaceCollector extends JsonApiCollector {
    async fetchItems() {
        const ns = this.params.namespace;
        const q = new URLSearchParams({ ordering: 'last_updated', page_size: String(this.params.pageSize || 50) });
        const res = await this.getJson(`https://hub.docker.com/v2/namespaces/${encodeURIComponent(ns)}/repositories?${q}`);
        // The 'ai' namespace is Docker's own organisation, not a person.
        return (res.data.results || []).map(r => ({
            // G10-14: a stable id per repository. The old `@last_updated`
            // suffix made every push a NEW post; an updated repository now
            // dedups to the post already stored (raw_posts rows are
            // immutable, so the first-collected text stays, as audited).
            id: `${ns}/${r.name}`,
            title: `${ns}/${r.name}`,
            text: r.description || '',
            url: `https://hub.docker.com/r/${ns}/${r.name}`,
            publishedAt: r.last_updated,
        }));
    }
}

class HfDailyPapersCollector extends JsonApiCollector {
    async fetchItems() {
        const headers = {};
        if (this.envValue('HF_TOKEN')) headers.Authorization = `Bearer ${this.envValue('HF_TOKEN')}`;
        const res = await this.getJson(`https://huggingface.co/api/daily_papers?limit=${this.params.limit || 30}`, { headers });
        return (res.data || []).map((d) => {
            const p = d.paper || {};
            return {
                id: p.id || d.id,
                title: p.title || d.title,
                text: p.summary || d.summary || '',
                url: p.id ? `https://huggingface.co/papers/${p.id}` : null,
                publishedAt: d.publishedAt || p.publishedAt,
            };
        });
    }
}

/** Discourse forum topics: /latest.json or /tag/<tag>.json. Usernames/avatars dropped. */
class DiscourseCollector extends JsonApiCollector {
    static get robotsGated() { return true; }   // community sites publish robots.txt

    async fetchItems() {
        const base = this.params.baseUrl.replace(/\/$/, '');
        const path = this.params.tag ? `/tag/${encodeURIComponent(this.params.tag)}.json` : '/latest.json';
        const res = await this.getJson(`${base}${path}`, { cache: this.httpCache });
        if (res.notModified) return [];
        const topics = (res.data.topic_list && res.data.topic_list.topics) || [];
        return topics.filter(t => !t.pinned).map(t => ({
            id: t.id,
            title: t.fancy_title || t.title,
            text: t.excerpt || '',
            url: `${base}/t/${t.slug}/${t.id}`,
            publishedAt: t.created_at,
        }));
    }
}

module.exports = {
    GithubSearchCollector, GitlabProjectsCollector, DockerHubNamespaceCollector,
    HfDailyPapersCollector, DiscourseCollector,
};
