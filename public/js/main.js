// PulseMain — page-shell bootstrap for the Pulse of AI story frontend.
// Rewritten in C1c: the previous main.js served the legacy Mapbox shell
// (#refresh-btn / #health-status markup) that public/index.html no longer
// renders.
//
// Responsibilities (shell only — rendering belongs to C2–C4 modules):
//   1. Size the scroll spacer exactly from the beat count + pacing config.
//   2. Run the header "time to insight" timer; expose freezeInsightTimer()
//      so ui.js (C4) can freeze it at the first opened receipt (US-1).
//   3. Wire the header health chip to GET /api/health (light + label only;
//      the full health drawer is C4).
//   4. Wire the intro "Skip to the globe →" link and the skip-story pill to
//      jump to the explore beat, so the page is navigable before story.js.
//   5. Initialize globe.js / story.js / ui.js when present — and tolerate
//      their absence (they land in C2–C4).
//
// DOM discipline: createElement/textContent/classList ONLY — the repo Write
// hook blocks innerHTML in client JS, and all strings here may echo API data.
(function () {
    'use strict';

    /* eslint-disable-next-line no-undef */
    const designConfig = window.PulseDesignConfig;
    const apiConfig = window.PulseApiConfig;
    const storyConfig = window.PulseStoryConfig;

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
    function setHealthChip(state, label) {
        const chip = document.getElementById('health-chip');
        const labelEl = document.getElementById('health-label');
        if (!chip || !labelEl) return;
        chip.classList.remove('h-green', 'h-yellow');
        chip.classList.add(state === 'yellow' ? 'h-yellow' : 'h-green');
        labelEl.textContent = label;
    }

    function pollHealth() {
        if (!apiConfig || typeof fetch !== 'function') return;
        fetch(apiConfig.ENDPOINTS.health)
            .then((res) => {
                if (!res.ok) throw new Error('health ' + res.status);
                return res.json();
            })
            .then((data) => {
                const alerts = Array.isArray(data.active_alerts)
                    ? data.active_alerts.length : 0;
                if (alerts > 0) {
                    setHealthChip('yellow', alerts === 1
                        ? '1 active alert'
                        : alerts + ' active alerts');
                } else {
                    setHealthChip('green', 'model health: nominal');
                }
            })
            .catch(() => {
                // Unreachable backend: surface attention, never fake "nominal".
                setHealthChip('yellow', 'model health: unavailable');
            });
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

    // Shared shell surface for later modules (freeze timer on first receipt,
    // programmatic jump to explore).
    window.PulseMain = { freezeInsightTimer, scrollToExplore };

    document.addEventListener('DOMContentLoaded', () => {
        sizeSpacer();
        startInsightTimer();
        pollHealth();
        wireSkips();
        initModules();
    });
}());
