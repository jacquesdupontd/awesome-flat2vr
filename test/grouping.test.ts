import { test } from 'vitest';
import assert from 'node:assert/strict';
import { pickWikiPage, isStoreArt } from '../scripts/enrich.mjs';
import { render } from '../scripts/render.mjs';

test("render lists every port of a game in that game's single row", () => {
  const mk = (name: string, platform: string) => ({
    name,
    games: ['Quake'],
    platform,
    status: 'beta',
    version: '1',
    version_date: '2026-01-01',
    download_url: 'https://x/d',
    source_url: `https://x/${name}`,
    authors: [{ name: 'A' }],
  });
  const md = render([mk('QuakeQuest', 'standalone'), mk('Quake VR: UNLEASHED', 'pcvr')]);
  const body = md.split('\n').slice(2);
  assert.equal(body.length, 1, 'one row for one game');
  assert.match(body[0]!, /\*\*Quake\*\* \| \[Quake VR: UNLEASHED\].*<br><br>\[QuakeQuest\]/);
  assert.match(body[0]!, /\*\*QuakeQuest\*\*<br>Standalone/);
});

test('pickWikiPage only accepts an article titled as the game', () => {
  const img = { source: 'https://upload.wikimedia.org/x.jpg' };
  assert.equal(pickWikiPage('Quake', [{ title: 'Quake II', original: img }]), null);
  assert.equal(pickWikiPage('Quake', [{ title: 'Quake (video game)', original: img }])?.title, 'Quake (video game)');
  assert.equal(
    pickWikiPage('Doom (2016)', [
      { title: 'Doom (1993 video game)', original: img },
      { title: 'Doom (2016 video game)', original: img },
    ])?.title,
    'Doom (2016 video game)',
  );
});

test('isStoreArt rejects YouTube thumbnails and repo cards', () => {
  assert.ok(isStoreArt({ credit: 'Quake grid by x (SteamGridDB)' }));
  assert.ok(isStoreArt({ credit: 'Quake store art' }));
  assert.ok(isStoreArt({ credit: 'Quake (video game) (Wikipedia)' }));
  assert.ok(!isStoreArt({ credit: 'NotAGameAddict' }));
  assert.ok(!isStoreArt({ credit: 'Team-Beef-Studios/RazeXR' }));
});
