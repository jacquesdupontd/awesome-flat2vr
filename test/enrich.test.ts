import { test } from 'vitest';
import assert from 'node:assert/strict';
import { pickSteamApp, isReview } from '../scripts/enrich.mjs';
import { rows, render } from '../scripts/render.mjs';

test('pickSteamApp prefers an exact title, never a longer unrelated one', () => {
  const items = [
    { id: 1, name: 'Blood Strike' },
    { id: 2, name: 'Blood' },
  ];
  assert.equal(pickSteamApp('Blood', items)?.id, 2);
  assert.equal(pickSteamApp('Hexen', [{ id: 3, name: 'Hexen Hegemony' }]), null);
  assert.equal(pickSteamApp('Quake II', [{ id: 4, name: 'Quake II' }])?.id, 4);
});

const port = { name: 'Lambda1VR', games: ['Half-Life'], platform: 'standalone' };
test('isReview keeps videos naming the port or the game in VR on the right platform', () => {
  assert.ok(isReview({ title: 'Lambda1VR - Half Life / Oculus Quest', duration: 700 }, port, 'Half-Life'));
  assert.ok(isReview({ title: 'Half-Life VR on Quest 2', duration: 700 }, port, 'Half-Life'));
  assert.ok(!isReview({ title: 'Half-Life VR on Index (PCVR)', duration: 700 }, port, 'Half-Life'), 'wrong platform');
  assert.ok(!isReview({ title: 'Lambda1VR #shorts', duration: 40 }, port, 'Half-Life'), 'shorts');
  assert.ok(
    !isReview({ title: 'Facebook buys Beat Saber, Quest update & Lambda1VR', duration: 900 }, port, 'Half-Life'),
    'news roundup',
  );
});

test('render puts one row per game, game first, sorted by game', () => {
  const p = {
    name: 'RazeXR',
    games: ['Duke Nukem 3D', 'Blood'],
    platform: 'standalone',
    status: 'stable',
    version: 'v1',
    version_date: '2023-09-30',
    download_url: 'https://x/d',
    source_url: 'https://x/s',
    authors: [{ name: 'Team Beef' }],
    images: [{ game: 'Blood', file: 'images/razexr/blood.jpg', credit: 'c', source_url: 'https://s' }],
  };
  assert.deepEqual(
    rows([p]).map((r) => r.game),
    ['Blood', 'Duke Nukem 3D'],
  );
  const md = render([p]);
  assert.match(md, /^\| Game \| Port \| Platform \|/);
  assert.match(md, /<img src="images\/razexr\/blood.jpg"[^|]*\*\*Blood\*\* \| \[RazeXR\]/);
});

test('isReview: numerals must match and VorpX videos are not this port', () => {
  const gta = { name: 'Grand Theft Auto IV VR', games: ['Grand Theft Auto IV'], platform: 'pcvr' };
  assert.ok(!isReview({ title: 'Grand Theft Auto V VR Mod gameplay', duration: 600 }, gta, 'Grand Theft Auto IV'));
  assert.ok(isReview({ title: 'Grand Theft Auto IV in VR is wild', duration: 600 }, gta, 'Grand Theft Auto IV'));
  const sh = { name: 'Space Hulk VR', games: ['Space Hulk: Deathwing'], platform: 'pcvr' };
  assert.ok(!isReview({ title: 'Space Hulk Deathwing in VR using Vorpx', duration: 600 }, sh, 'Space Hulk: Deathwing'));
});

test('pickSteamApp accepts "The Complete Edition" of the same game', () => {
  const items = [{ id: 12210, name: 'Grand Theft Auto IV: The Complete Edition' }];
  assert.equal(pickSteamApp('Grand Theft Auto IV', items)?.id, 12210);
});

test('render escapes quotes in the image alt text', () => {
  const md = render([
    {
      name: 'P',
      games: ['Say "Hi"'],
      platform: 'pcvr',
      status: 'beta',
      version: '1',
      version_date: '2026-01-01',
      download_url: 'https://x/d',
      source_url: 'https://x/s',
      authors: [{ name: 'A' }],
      known_bugs: ['crash on load'],
      images: [{ game: 'Say "Hi"', file: 'images/p/say-hi.jpg', credit: 'c', source_url: 'https://s' }],
    },
  ]);
  assert.match(md, /alt="Say &quot;Hi&quot;"/);
  assert.match(md, /1 known bug/);
});

test('isReview: a sequel video is not a review of the original game', () => {
  const hl = { name: 'Half-Life: VR Mod', games: ['Half-Life'], platform: 'pcvr' };
  assert.ok(!isReview({ title: 'Living in Half Life 2 VR until I beat it', duration: 900 }, hl, 'Half-Life'));
  assert.ok(isReview({ title: 'Half-Life VR Mod is incredible', duration: 900 }, hl, 'Half-Life'));
  const hl2 = { name: 'Half-Life 2: VR Mod', games: ['Half-Life 2'], platform: 'pcvr' };
  assert.ok(isReview({ title: 'Half-Life 2 VR is Really THAT Good', duration: 900 }, hl2, 'Half-Life 2'));
});
