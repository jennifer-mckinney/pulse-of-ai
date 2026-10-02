// PulseMain — page-shell bootstrap for the Pulse of AI story frontend.
// Rewritten in C1c: the previous main.js served the legacy map shell
// (#refresh-btn / #health-status markup) that public/index.html no longer
// renders.
//
// Responsibilities (shell only — rendering belongs to C2–C4 modules):
//   1. Size the scroll spacer exactly from the beat count + pacing config.
//   2. Run the header "time to insight" timer; expose freezeInsightTimer()
//      so ui.js (C4) can freeze it at the first opened receipt (US-1).
//   3. Wire the header health chip to GET /api/health (light + label only;
//      the full health drawer is C4), re-polled on the api.config REFRESH_MS
//      cadence so alerts raised after load turn the chip yellow (or red for a
//      critical alert) without a page reload (FR-24). The colour mapping is
//      PulseUtils.healthState — shared with ui.js so every chip path agrees.
//   4. Wire the intro "Skip to the globe →" link and the skip-story pill to
//      jump to the explore beat, so the page is navigable before story.js.
//   5. Initialize globe.js / story.js / ui.js when present — and tolerate
//      their absence (they land in C2–C4).
//   6. Render the Appropriate Legal Notices (AGPL-3.0-or-later plus the
//      section 7(b) attribution, config/legal.config.js) into the header
//      "about" panel, and wire the "about" chip that opens it.
//
// DOM discipline: createElement/textContent/classList ONLY — the repo Write
// hook blocks innerHTML in client JS, and all strings here may echo API data.
(function () {
    'use strict';

    /* eslint-disable-next-line no-undef */
    const designConfig = window.PulseDesignConfig;
    const apiConfig = window.PulseApiConfig;
    const storyConfig = window.PulseStoryConfig;
    const legalConfig = window.PulseLegalConfig;
    const utils = window.PulseUtils;

    const loadedAt = Date.now();
    let frozenSeconds = null;   // set once by freezeInsightTimer()
    let timerId = null;

    // mm:ss like the prototype header (0-padded seconds only → "0:00").
    function fmtClock(totalSeconds) {
        const mm = String(Math.floor(totalSeconds / 60));
        const ss = String(totalSeconds % 60).padStart(2, '0');
        return mm + ':' + ss;
    }

    // ── 1. Scroll spacer: (N−1) × pacing × 100vh + 100vh ────────────────────
    function sizeSpacer() {
        const spacer = document.getElementById('scroll-spacer');
        if (!spacer || !storyConfig || !designConfig) return;
        const beats = storyConfig.STORY.length;
        const pacing = designConfig.GLOBE.pacingVhPerChapter;
        spacer.style.height =
            ((beats - 1) * pacing * 100 + 100) + 'vh';
    }

    // ── 2. Time-to-insight timer ────────────────────────────────────────────
    function startInsightTimer() {
        const timerEl = document.getElementById('insight-timer');
        if (!timerEl) return;
        timerId = setInterval(() => {
            if (frozenSeconds != null) return;
            const secs = Math.round((Date.now() - loadedAt) / 1000);
            timerEl.textContent = fmtClock(secs);
        }, 1000);
    }

    // Freeze at the first opened receipt; ui.js (C4) calls this. Idempotent.
    function freezeInsightTimer() {
        if (frozenSeconds != null) return frozenSeconds;
        frozenSeconds = Math.round((Date.now() - loadedAt) / 1000);
        if (timerId != null) { clearInterval(timerId); timerId = null; }
        const timerEl = document.getElementById('insight-timer');
        const labelEl = document.getElementById('insight-label');
        if (timerEl) timerEl.textContent = fmtClock(frozenSeconds);
        if (labelEl) labelEl.textContent = 'first receipt ✓';
        return frozenSeconds;
    }

    // ── 3. Health chip (light + label; drawer content is C4) ────────────────
    // system = a watchdog alert is open (PR #22 principal #12): the chip is
    // emphasized (h-system) and its label names the condition.
    function setHealthChip(state, label, system) {
        const chip = document.getElementById('health-chip');
        const labelEl = document.getElementById('health-label');
        if (!chip || !labelEl) return;
        chip.classList.remove('h-green', 'h-yellow', 'h-red');
        chip.classList.add('h-' + state);
        chip.classList.toggle('h-system', system === true);
        labelEl.textContent = label;
    }

    // Apply the shared FR-24 mapping (critical → red, other alerts /
    // degraded / unreachable → yellow, else green). null = unreachable.
    function applyHealth(data) {
        if (!utils || typeof utils.healthState !== 'function') {
            // utils.js failed to load — surface attention, never fake nominal.
            setHealthChip('yellow', 'model health: unavailable');
            return;
        }
        const hs = utils.healthState(data);
        setHealthChip(hs.state, hs.label,
            Array.isArray(hs.systemAlerts) && hs.systemAlerts.length > 0);
    }

    function pollHealth() {
        if (!apiConfig || typeof fetch !== 'function') return;
        fetch(apiConfig.ENDPOINTS.health)
            .then((res) => {
                if (!res.ok) throw new Error('health ' + res.status);
                return res.json();
            })
            .then(applyHealth)
            // Unreachable backend: surface attention, never fake "nominal".
            .catch(() => applyHealth(null));
    }

    // ── 4. Skip-to-explore navigation (story.js refines this in C3) ─────────
    function scrollToExplore() {
        if (!storyConfig || !designConfig) return;
        const beats = storyConfig.STORY.length;
        const pacing = designConfig.GLOBE.pacingVhPerChapter;
        const reduced = window.matchMedia
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({
            top: (beats - 1) * pacing * window.innerHeight,
            behavior: reduced ? 'auto' : 'smooth',
        });
    }

    function wireSkips() {
        const introSkip = document.getElementById('intro-skip');
        const skipBtn = document.getElementById('skip-btn');
        if (introSkip) introSkip.addEventListener('click', scrollToExplore);
        if (skipBtn) skipBtn.addEventListener('click', scrollToExplore);
    }

    // ── 5. Renderer modules (C2–C4) — optional until they land ──────────────
    function initModules() {
        ['PulseGlobe', 'PulseStory', 'PulseUI'].forEach((name) => {
            const mod = window[name];
            if (mod && typeof mod.init === 'function') {
                mod.init();
            } else {
                // Expected until C2/C3/C4 land — shell renders without them.
                console.info('[pulse] ' + name + ' not loaded yet; shell-only mode.');
            }
        });
    }

    // ── 6. Legal notices (AGPL-3.0-or-later, section 7(b) attribution) ────
    // One list item per legalConfig.NOTICE entry, built with
    // createElement/textContent; entries with an href become links. The
    // panel starts hidden and the "about" chip toggles it (Escape closes).
    // isValidNoticeConfig: the config replaces the static notices only when it
    // is COMPLETE: a non-empty array whose every entry is an object with a
    // non-empty string id and text (and a string href when present), that
    // carries each REQUIRED id exactly once (a partial or duplicated list
    // would silently drop or repeat the AGPL section 7(b) attribution), with
    // a non-empty href on the notices that must link (attribution, licence,
    // terms, source). Extra notices with other ids are allowed. Anything else
    // takes the fallback path and leaves the static, interactive notices in
    // place; nothing here throws, so initModules() always runs.
    const REQUIRED_NOTICE_IDS = ['copyright', 'attribution', 'license', 'terms', 'source', 'warranty'];
    const LINKED_NOTICE_IDS = ['attribution', 'license', 'terms', 'source'];
    function isValidNoticeConfig(cfg) {
        if (!cfg || !Array.isArray(cfg.NOTICE) || cfg.NOTICE.length === 0) return false;
        const wellFormed = cfg.NOTICE.every((item) => !!item && typeof item === 'object'
            && typeof item.id === 'string' && item.id !== ''
            && typeof item.text === 'string' && item.text !== ''
            && (item.href === undefined || typeof item.href === 'string'));
        if (!wellFormed) return false;
        const ids = cfg.NOTICE.map((item) => item.id);
        if (new Set(ids).size !== ids.length) return false;   // duplicate id
        if (!REQUIRED_NOTICE_IDS.every((id) => ids.indexOf(id) !== -1)) return false;
        return cfg.NOTICE.every((item) => LINKED_NOTICE_IDS.indexOf(item.id) === -1
            || (typeof item.href === 'string' && item.href !== ''));
    }

    function renderLegalNotice() {
        const panel = document.getElementById('about-panel');
        const chip = document.getElementById('about-chip');
        if (!panel || !chip) return;
        // The panel ships its notices as static markup in index.html, so the
        // AGPL section 7(b) attribution stays reachable (chip + panel) even if
        // legal.config.js fails to load (404, CSP, load order). When the
        // config IS present its list replaces the static one; otherwise the
        // static list stays and a warning is logged.
        if (isValidNoticeConfig(legalConfig)) {
            const list = document.createElement('ul');
            list.className = 'about-list';
            legalConfig.NOTICE.forEach((item) => {
                const li = document.createElement('li');
                li.className = 'about-item';
                li.setAttribute('data-notice', item.id);
                if (item.href) {
                    const a = document.createElement('a');
                    a.href = item.href;
                    a.rel = 'noopener noreferrer';
                    a.textContent = item.text;
                    li.appendChild(a);
                } else {
                    li.textContent = item.text;
                }
                list.appendChild(li);
            });
            while (panel.firstChild) panel.removeChild(panel.firstChild);
            panel.appendChild(list);
        } else if (typeof console !== 'undefined' && console.warn) {
            console.warn('legal notices: PulseLegalConfig missing or malformed; showing the static notices');
        }

        const setOpen = (open) => {
            panel.hidden = !open;
            chip.setAttribute('aria-expanded', open ? 'true' : 'false');
        };
        // close: hiding the panel would strand keyboard focus inside a hidden
        // subtree when it sits on one of the panel's links, so focus returns
        // to the controlling chip. Whether it is inside is read BEFORE the
        // panel hides. Focus that is elsewhere on the page (another control
        // the user moved to) is left where it is. Shared by Escape and the
        // chip click: in Safari a click does not focus the button, so a
        // focused notice link would otherwise stay focused when the chip
        // closes the panel (Copilot r4158521470).
        const close = () => {
            const active = document.activeElement;
            const returnFocus = !active || active === document.body
                || active === chip || panel.contains(active);
            setOpen(false);
            if (returnFocus) chip.focus();
        };
        // A drawer (z-index 50) covers the panel (30): opening the panel
        // behind an open drawer would set aria-expanded on something nobody
        // can see, so the chip does nothing while a drawer is open.
        const drawerOpen = () => !!document.querySelector('#audit-drawer.open, #health-drawer.open');
        chip.addEventListener('click', () => {
            if (panel.hidden) { if (!drawerOpen()) setOpen(true); }
            else close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || panel.hidden) return;
            close();
        });
        // A drawer opening (receipt, health) sits above the panel (z-index 50
        // vs 30): fold the panel away so it is not left expanded and focusable
        // behind the drawer, whichever path opened it (PulseUI.openAudit is
        // called directly as well as through the pulse:trace event). The
        // drawers toggle an `open` class, so that is observed rather than one
        // event. Focus is NOT moved: the drawer's own opener handling owns it.
        // The one exception: when focus sits INSIDE the panel being folded (a
        // notice link was focused and the drawer opened without moving
        // focus, e.g. a Safari click that does not focus the button), focus
        // would be stranded in a hidden subtree, so it moves to the opened
        // drawer (a dialog; made programmatically focusable).
        const foldAway = (drawer) => {
            if (panel.hidden) return;
            const strandsFocus = panel.contains(document.activeElement);
            setOpen(false);
            if (strandsFocus && drawer && typeof drawer.focus === 'function') {
                drawer.setAttribute('tabindex', '-1');
                drawer.focus();
            }
        };
        if (typeof MutationObserver !== 'undefined') {
            // Only a drawer GAINING `open` folds the panel: another class
            // change on an already-open drawer must not close a panel the
            // user has just opened (attributeOldValue gives the old classes).
            // While a drawer is open the chip is inert (see drawerOpen):
            // say so to assistive technology instead of failing silently.
            const syncChip = () => {
                if (drawerOpen()) chip.setAttribute('aria-disabled', 'true');
                else chip.removeAttribute('aria-disabled');
            };
            const observer = new MutationObserver((records) => {
                syncChip();
                const opened = records.find((r) => r.target.classList.contains('open')
                    && !String(r.oldValue || '').split(/\s+/).includes('open'));
                if (opened) foldAway(opened.target);
            });
            ['audit-drawer', 'health-drawer'].forEach((id) => {
                const d = document.getElementById(id);
                if (d) observer.observe(d, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
            });
            syncChip();
        }
    }

    // Shared shell surface for later modules (freeze timer on first receipt,
    // programmatic jump to explore).
    window.PulseMain = { freezeInsightTimer, scrollToExplore };

    document.addEventListener('DOMContentLoaded', () => {
        sizeSpacer();
        startInsightTimer();
        pollHealth();
        // Health is a live signal, not a load-time snapshot: re-poll on the
        // same refresh cadence as the data snapshot (story.js uses
        // apiConfig.REFRESH_MS for loadAndRender) so the FR-24 traffic light
        // reflects alerts that arrive while the page is open.
        if (apiConfig && Number.isFinite(apiConfig.REFRESH_MS)) {
            setInterval(pollHealth, apiConfig.REFRESH_MS);
        }
        wireSkips();
        renderLegalNotice();
        initModules();
    });
}());
