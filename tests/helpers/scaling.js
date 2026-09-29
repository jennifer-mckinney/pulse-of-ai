// tests/helpers/scaling.js
// Load-robust complexity checks for the ReDoS / entity-expansion
// regressions (F10-3, F10-15). A fixed wall-clock budget (e.g. 50 ms) flakes
// when the machine is busy (120 ms under a full parallel suite), so each
// check measures the SAME code on a small and a 4× larger input (median of
// several runs, after a warm-up) and asserts how the time grows:
//
//   linear      ×4 input → ~×4 time
//   quadratic   ×4 input → ~×16 time   (the F10-3 bug: 1 MB took minutes)
//   exponential far worse
//
// It passes when the large input runs under FAST_MS outright (a quadratic
// pattern cannot finish 1 MB that fast), or when time grows by less than
// MAX_RATIO; and it always fails past HARD_MS, whatever the load.

'use strict';

const FAST_MS = 25;
const MAX_RATIO = 10;
const HARD_MS = 3000;

function medianMs(fn, reps) {
    const t = [];
    for (let i = 0; i < reps; i++) {
        const t0 = process.hrtime.bigint();
        fn();
        t.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    t.sort((a, b) => a - b);
    return t[Math.floor(t.length / 2)];
}

/**
 * @param {(input: string) => unknown} fn
 * @param {(n: number) => string} make  input of about n characters
 * @param {number} [n]                  the large size (small = n / 4)
 * @returns {{ small: number, large: number, ratio: number, linear: boolean }}
 */
function scaling(fn, make, n = 1024 * 1024, reps = 5) {
    const small = make(n / 4);
    const large = make(n);
    fn(small); fn(large);                        // warm-up (JIT)
    const s = medianMs(() => fn(small), reps);
    const l = medianMs(() => fn(large), reps);
    const ratio = l / Math.max(s, 0.05);
    return { small: s, large: l, ratio, linear: l < HARD_MS && (l < FAST_MS || ratio < MAX_RATIO) };
}

/** Async variant (parsers returning promises). */
async function scalingAsync(fn, make, sizes, reps = 5) {
    const [a, b] = sizes;
    const time = async (input) => {
        const t = [];
        for (let i = 0; i < reps; i++) {
            const t0 = process.hrtime.bigint();
            try { await fn(input); } catch { /* the outcome is asserted elsewhere */ }
            t.push(Number(process.hrtime.bigint() - t0) / 1e6);
        }
        t.sort((x, y) => x - y);
        return t[Math.floor(t.length / 2)];
    };
    const small = make(a);
    const large = make(b);
    await time(small); await time(large);
    const s = await time(small);
    const l = await time(large);
    return { small: s, large: l, ratio: l / Math.max(s, 0.05) };
}

module.exports = { scaling, scalingAsync, FAST_MS, MAX_RATIO, HARD_MS };
