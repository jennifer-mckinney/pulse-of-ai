// tests/unit/pure/workerGuard.test.js — PR #22 principal #6: the cycle-close
// timer body never overlaps itself.
const { nonReentrant } = require('../../../src/workers/guard');

it('a tick still in flight makes the next one skip; the guard is released after errors', async () => {
    let release; let calls = 0;
    const tick = nonReentrant(() => { calls++; return new Promise(r => { release = r; }); }, { onSkip: () => { skipped++; } });
    let skipped = 0;
    const first = tick();
    expect(await tick()).toBe(false);
    expect(await tick()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(calls).toBe(1);
    expect(skipped).toBe(2);

    const failing = nonReentrant(async () => { throw new Error('boom'); });
    await expect(failing()).rejects.toThrow('boom');
    await expect(failing()).rejects.toThrow('boom');   // not stuck
});
