// tests/unit/pure/claimSlack.test.js — G10-16: claim slack is 20% of the
// collection window (capped at 20% of the source's interval), not 10 s.

'use strict';

const { claimSlackSec, CLAIM_SLACK_FRACTION } = require('../../../src/collectors/state');

test('20% of a 150 s window is 30 s for a 150–180 s source', () => {
    expect(CLAIM_SLACK_FRACTION).toBe(0.2);
    expect(claimSlackSec(150, 150000)).toBe(30);
    expect(claimSlackSec(180, 150000)).toBe(30);
});

test('never more than 20% of the source\'s own interval; 10 s floor otherwise', () => {
    expect(claimSlackSec(60, 150000)).toBe(12);
    expect(claimSlackSec(900, 600000)).toBe(120);
    expect(claimSlackSec(900, 10000)).toBe(10);
    expect(claimSlackSec(20, 150000)).toBe(4);
});
