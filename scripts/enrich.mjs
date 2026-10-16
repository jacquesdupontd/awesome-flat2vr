#!/usr/bin/env node
// Fill in a port's game images and YouTube reviews.
//   node scripts/enrich.mjs [slug ...] [--force] [--no-reviews]
// With no slugs, enriches every ports/*.yml that is missing an image or reviews.
// Images: SteamGridDB 920x430 grid for each game, else the Steam 616x353 capsule (header as
// fallback), else the lead image of the game's Wikipedia article. Never a YouTube thumbnail or a
// repo social card: those show the wrong game, so no image beats a wrong one.
// Reviews: yt-dlp YouTube search.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { ROOT } from './lib.mjs';
import { toYaml } from './discover/core.mjs';

const UA = { 'user-agent': 'awesome-flat2vr-enrich/1.0 (+https://github.com/jrejaud/awesome-flat2vr)' };

export const norm = (s) =>
  String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[™®©:'’!.,\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
export const slugify = (s) =>
  norm(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// Pick the Steam app whose name matches the game: exact (normalized) first, then a
// name that starts with the game title. Returns { id, name } or null.
export function pickSteamApp(game, items) {
  const want = norm(game);
  const year = /\((\d{4})\)/.exec(game)?.[1];
  const cands = items.map((i) => ({ id: i.id, name: i.name, n: norm(i.name) }));
  const exact = cands.filter((c) => c.n === want);
  if (exact.length) return exact[0];
  if (year) {
    const withYear = cands.find((c) => c.name.includes(year) && c.n.startsWith(want));
    if (withYear) return withYear;
  }
  // Only accept a longer title when the extra words are an edition of the same game.
  const edition =
    /^(the|remastered|classic|enhanced|definitive|complete|anniversary|gold|goty|game of the year|deluxe|biohazard|version|\d+th anniversary.*|\d{4}|edition| )+$/;
  return cands.find((c) => c.n.startsWith(`${want} `) && edition.test(c.n.slice(want.length + 1))) ?? null;
}

async function steamApp(game) {
  const q = encodeURIComponent(game.replace(/\(.*?\)/g, '').trim());
  const data = await retry(() => getJson(`https://store.steampowered.com/api/storesearch/?term=${q}&l=english&cc=US`));
  return pickSteamApp(game, data.items ?? []);
}

async function retry(fn, n = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= n) throw e;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

async function steamHeader(id) {
  const d = await retry(() => getJson(`https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic`));
  const app = d?.[id]?.data;
  // Delisted apps (e.g. Mirror's Edge) return no data but still serve their store art.
  if (!app)
    return {
      name: `Steam app ${id}`,
      url: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`,
    };
  return { name: app.name, url: app.header_image };
}

// SteamGridDB: community art for every game, Steam or not (N64, GameCube, Xbox). The key is
// STEAMGRIDDB_API_KEY, else resolved in-process from 1Password (never on a command line).
const SGDB_OP_REF = 'op://zs2nbxfxnbbm3nwlkpbogyaq6y/4mqftjxe4rxkvydgz7uaoaslsa/password';
let sgdbKeyCache;
function sgdbKey() {
  if (sgdbKeyCache !== undefined) return sgdbKeyCache;
  sgdbKeyCache = process.env.STEAMGRIDDB_API_KEY || null;
  if (!sgdbKeyCache) {
    try {
      sgdbKeyCache = execFileSync('op', ['read', SGDB_OP_REF], { encoding: 'utf8', timeout: 30e3 }).trim() || null;
    } catch {
      sgdbKeyCache = null;
    }
  }
  return sgdbKeyCache;
}

async function sgdbJson(path) {
  const r = await fetch(`https://www.steamgriddb.com/api/v2/${path}`, {
    headers: { ...UA, authorization: `Bearer ${sgdbKey()}` },
  });
  if (!r.ok) throw new Error(`${r.status} steamgriddb ${path}`);
  return r.json();
}

// Best-voted static landscape grid for the game, matched by exact title (pickSteamApp rules),
// so "Half-Life 2: Episode One" never takes "Half-Life 2"'s art.
export async function sgdbGrid(game, { avoid = new Set() } = {}) {
  if (!sgdbKey()) return null;
  const q = encodeURIComponent(game.replace(/\(.*?\)/g, '').trim());
  const found = await retry(() => sgdbJson(`search/autocomplete/${q}`));
  let items = (found.data ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    year: g.release_date ? new Date(g.release_date * 1000).getUTCFullYear() : null,
  }));
  // "DOOM (2016)": two games are both titled "Doom", so the year decides between them.
  const year = Number(/\((\d{4})\)/.exec(game)?.[1]);
  if (year && items.some((i) => i.year === year)) items = items.filter((i) => i.year === year || !i.year);
  const hit = pickSteamApp(game, items);
  if (!hit) return null;
  for (const dims of ['920x430', '460x215']) {
    const grids = await retry(() =>
      sgdbJson(`grids/game/${hit.id}?dimensions=${dims}&types=static&nsfw=false&humor=false`),
    );
    // Skip art another game of the same port already uses (a combined "Red/Blue" grid).
    const g = (grids.data ?? []).filter((x) => /\.(jpe?g|png)$/i.test(x.url) && !avoid.has(x.url))[0];
    if (g)
      return {
        url: g.url,
        ext: /\.png$/i.test(g.url) ? 'png' : 'jpg',
        credit: `${hit.name} grid by ${g.author?.name ?? 'unknown'} (SteamGridDB)`,
        source_url: `https://www.steamgriddb.com/grid/${g.id}`,
      };
  }
  return null;
}

// Cover from the game's Wikipedia article infobox. Only an article whose title is the game's
// (optionally "(video game)") counts, so a search never lands on a different game. The cover is a
// non-free file, which the pageimages API omits, so the infobox's image field is read directly.
const flat = (s) => norm(s).replace(/[^a-z0-9]/g, '');
export function pickWikiPage(game, pages) {
  const want = flat(game);
  const year = /\((\d{4})\)/.exec(game)?.[1];
  const title = (p) => flat(p.title.replace(/\((?:\d{4} )?(?:video )?game\)/i, ''));
  const hits = pages.filter((p) => title(p) === want);
  return (year && hits.find((p) => p.title.includes(year))) || hits[0] || null;
}

export function infoboxImage(wikitext) {
  const m = /\|\s*(?:image|cover)\s*=\s*(?:\[\[)?(?:File:|Image:)?([^|\n\]]+\.(?:jpe?g|png))/i.exec(wikitext ?? '');
  return m ? m[1].trim() : null;
}

export async function wikiImage(game) {
  const api = 'https://en.wikipedia.org/w/api.php?format=json&action=query';
  const q = encodeURIComponent(`${game.replace(/\(.*?\)/g, '').trim()} video game`);
  const found = await retry(() => getJson(`${api}&list=search&srlimit=8&srsearch=${q}`));
  const page = pickWikiPage(game, found.query?.search ?? []);
  if (!page) return null;
  const rev = await retry(() =>
    getJson(`${api}&prop=revisions&rvprop=content&rvslots=main&titles=${encodeURIComponent(page.title)}`),
  );
  const text = Object.values(rev.query?.pages ?? {})[0]?.revisions?.[0]?.slots?.main?.['*'];
  const file = infoboxImage(text);
  if (!file) return null;
  const info = await retry(() =>
    getJson(`${api}&prop=imageinfo&iiprop=url&titles=${encodeURIComponent(`File:${file}`)}`),
  );
  const url = Object.values(info.query?.pages ?? {})[0]?.imageinfo?.[0]?.url;
  if (!url) return null;
  return {
    url,
    ext: /\.png$/i.test(url) ? 'png' : 'jpg',
    credit: `${page.title} (Wikipedia)`,
    source_url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
  };
}

// Art sourced from a game database (SteamGridDB, Steam, Wikipedia) is about the game. Anything
// else (a YouTube thumbnail, a repo social card) is not, and is re-sourced.
export const isStoreArt = (i) => /\((SteamGridDB|Wikipedia)\)$|store art$/.test(i?.credit ?? '');

async function download(url, dest) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 2000) throw new Error(`image too small (${buf.length} B): ${url}`);
  mkdirSync(join(dest, '..'), { recursive: true });
  writeFileSync(dest, buf);
}

// Keep a review only if its title names VR and the game (or the port), and it isn't a Short.
// Title matching only: punctuation to spaces, roman numerals to digits ("Quake II" == "Quake 2").
const ROMAN = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6' };
const mnorm = (s) =>
  norm(s)
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ROMAN[w] ?? w)
    .join(' ');

export function isReview(v, entry, game) {
  const t = mnorm(v.title);
  const compact = t.replace(/\s+/g, '');
  if ((v.duration ?? 0) < 120) return false;
  // News roundups, and other injectors (VorpX) showing the same game, are not reviews of this port.
  if (/\bnews\b|roundup|weekly|top \d+|\d+ best|update &|vorpx/.test(String(v.title).toLowerCase())) return false;
  const port = mnorm(entry.name).replace(/\s+/g, '');
  if (port.length > 4 && compact.includes(port)) return true;
  // "Half-Life" must not match a "Half-Life 2" video: reject the game name followed by a
  // sequel number (1-2 digits, so "Tomb Raider 1996" is fine; "1" means the original).
  const g = mnorm(game);
  const at = ` ${t} `.indexOf(` ${g} `);
  const seq = at >= 0 ? /^(\d{1,2})\b/.exec(t.slice(at + g.length).trimStart()) : null;
  if (seq && seq[1] !== '1' && !g.endsWith(` ${seq[1]}`)) return false;
  if (!/\bvr\b|virtual reality/.test(t)) return false;
  // Whole-word match, keeping numerals so "Grand Theft Auto IV" never matches a GTA V video.
  const have = new Set(t.split(' '));
  const words = mnorm(game)
    .split(' ')
    .filter((w) => (w.length > 2 || /^([ivx]+|\d+)$/.test(w)) && w !== 'vr' && w !== 'the');
  if (!words.length || !words.every((w) => have.has(w))) return false;
  if (entry.platform === 'standalone') return /quest|sidequest|pico|standalone/.test(t);
  return true;
}

function searchYouTube(query, n = 10) {
  const out = execFileSync('yt-dlp', ['--flat-playlist', '--dump-json', '--no-warnings', `ytsearch${n}:${query}`], {
    encoding: 'utf8',
    timeout: 90_000,
  });
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((v) => ({
      id: v.id,
      title: v.title,
      channel: v.channel ?? v.uploader,
      duration: v.duration,
      views: v.view_count ?? 0,
    }));
}

export function findReviews(entry, max = 2) {
  const found = new Map();
  for (const game of entry.games) {
    const queries = [`${entry.name} ${game}`, `${game} VR ${entry.platform === 'standalone' ? 'Quest' : 'mod'}`];
    for (const q of queries) {
      for (const v of searchYouTube(q)) if (isReview(v, entry, game) && !found.has(v.id)) found.set(v.id, v);
    }
  }
  return [...found.values()]
    .sort((a, b) => b.views - a.views)
    .slice(0, max)
    .map((v) => ({ title: v.title, channel: v.channel, url: `https://www.youtube.com/watch?v=${v.id}` }));
}

// Mutates and returns `entry`: adds `images` (one per game) and `reviews`. Writes
// image files under <root>/images/<slug>/.
export async function enrich(
  entry,
  slug,
  { root = ROOT, force = false, reviews = true, steam = {}, log = () => {} } = {},
) {
  if (reviews && (force || !Array.isArray(entry.reviews))) {
    try {
      const r = findReviews(entry);
      // An empty search never wipes reviews already on file; [] records "searched, none found".
      if (r.length || !entry.reviews?.length) entry.reviews = r;
    } catch (e) {
      log(`  reviews: ${e.message.split('\n')[0]}`);
    }
  }
  const prev = new Map((entry.images ?? []).map((i) => [i.game, i]));
  const usable = (i) => i && existsSync(join(root, i.file)) && isStoreArt(i);
  const images = [];
  const usedUrls = new Set();
  const usedHashes = new Set();
  for (const game of entry.games) {
    if (!force && usable(prev.get(game))) {
      images.push(prev.get(game));
      continue;
    }
    const base = `images/${slug}/${slugify(game) || 'game'}`;
    // Write <base>.<ext> and drop a stale sibling with the other extension.
    const save = async (url, ext) => {
      await retry(() => download(url, join(root, `${base}.${ext}`)));
      for (const other of ['jpg', 'png']) {
        if (other !== ext && existsSync(join(root, `${base}.${other}`))) unlinkSync(join(root, `${base}.${other}`));
      }
      return `${base}.${ext}`;
    };
    let img = null;
    // An explicit --steam id pins the Steam store art; otherwise SteamGridDB goes first.
    if (!steam[game]) {
      try {
        // Up to 3 tries: the same artwork is sometimes uploaded twice under different URLs, so a
        // second game of the same port is compared by file content, not just by URL.
        for (let tries = 0; tries < 3 && !img; tries++) {
          const g = await sgdbGrid(game, { avoid: usedUrls });
          if (!g) break;
          usedUrls.add(g.url);
          const file = await save(g.url, g.ext);
          const hash = createHash('md5')
            .update(readFileSync(join(root, file)))
            .digest('hex');
          if (usedHashes.has(hash)) continue;
          usedHashes.add(hash);
          img = { game, file, credit: g.credit, source_url: g.source_url };
        }
      } catch (e) {
        log(`  steamgriddb ${game}: ${e.message}`);
      }
    }
    try {
      const app = img ? null : steam[game] ? { id: steam[game] } : await steamApp(game);
      if (app) {
        const h = await steamHeader(app.id);
        // The 616x353 capsule is ~1.8x the header's resolution; fall back to the header.
        const file = await save(h.url.replace(/header\.jpg(\?.*)?$/, 'capsule_616x353.jpg$1'), 'jpg').catch(() =>
          save(h.url, 'jpg'),
        );
        img = {
          game,
          file,
          credit: `${h.name} store art`,
          source_url: `https://store.steampowered.com/app/${app.id}/`,
        };
      }
    } catch (e) {
      log(`  steam ${game}: ${e.message}`);
    }
    if (!img) {
      try {
        const w = await wikiImage(game);
        if (w) img = { game, file: await save(w.url, w.ext), credit: w.credit, source_url: w.source_url };
      } catch (e) {
        log(`  wikipedia ${game}: ${e.message}`);
      }
    }
    // A failed refresh keeps the image already on file rather than losing it.
    if (!img && usable(prev.get(game))) img = prev.get(game);
    if (img) images.push(img);
    else log(`  no image found for ${game}`);
  }
  // A weak image nothing better replaced is dropped (file included): no image beats a wrong one.
  const kept = new Set(images.map((i) => i.file));
  for (const old of prev.values()) {
    if (!kept.has(old.file) && existsSync(join(root, old.file))) unlinkSync(join(root, old.file));
  }
  if (images.length) entry.images = images;
  else delete entry.images;
  const none = entry.games.filter((g) => !images.some((i) => i.game === g));
  if (none.length) entry.no_image = none;
  else delete entry.no_image;
  return entry;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const reviews = !args.includes('--no-reviews');
  const steam = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--steam') {
      const [g, id] = args[i + 1].split('=');
      steam[g] = Number(id);
      args.splice(i, 2);
      i--;
    }
  }
  const slugs = args.filter((a) => !a.startsWith('--'));
  const files = slugs.length
    ? slugs.map((s) => `${s}.yml`)
    : readdirSync(join(ROOT, 'ports')).filter((f) => f.endsWith('.yml'));
  let missing = 0;
  for (const f of files) {
    const path = join(ROOT, 'ports', f);
    const entry = yaml.load(readFileSync(path, 'utf8'), { schema: yaml.JSON_SCHEMA });
    const done =
      entry.images?.length === entry.games.length &&
      entry.images.every(isStoreArt) &&
      (!reviews || Array.isArray(entry.reviews));
    if (done && !force && !slugs.length) continue;
    const slug = f.replace(/\.yml$/, '');
    console.log(`→ ${slug}`);
    await enrich(entry, slug, { force, reviews, steam, log: console.log });
    console.log(`  images ${entry.images?.length ?? 0}/${entry.games.length}, reviews ${entry.reviews?.length ?? 0}`);
    if ((entry.images?.length ?? 0) < entry.games.length) missing++;
    writeFileSync(path, toYaml(entry));
  }
  if (missing) console.log(`${missing} port(s) have a game with no trustworthy art (recorded as no_image)`);
}
