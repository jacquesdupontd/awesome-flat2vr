import { test } from 'vitest';
import assert from 'node:assert/strict';
import { xReplyLeads } from '../scripts/discover/sources.mjs';

const NOW = Date.parse('2026-10-16T00:00:00Z');

test('twitter replies events: a DM or reply from someone else with a link and a VR hint is a lead', () => {
  const ev = (id: string, kind: string, text: string) => ({
    id,
    kind,
    by: 'tipster',
    text,
    url: 'https://x.com/tipster/status/5',
    created: '2026-10-14T00:00:00Z',
  });
  const leads = xReplyLeads(
    [
      ev('dm:1', 'dm', 'hey a UEVR mod for Dead Space just dropped https://github.com/x/ds-vr'),
      ev('dm:2', 'dm', 'hello how are you'),
      ev('tweet:3', 'comment-reply', 'Quest port of Halo here https://github.com/x/halo-quest'),
      ev('tweet:4', 'quote', 'VR mod https://github.com/x/y'),
    ],
    { now: NOW },
  );
  assert.deepEqual(
    leads.map((l) => [l.id, l.source]),
    [
      ['x:dm:1', 'X DM'],
      ['x:tweet:3', 'X reply'],
    ],
  );
});
