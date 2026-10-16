// Pure helpers for the discovery bot: dedupe keys, version comparison, turning a
// model extraction into a schema-valid entry, and YAML rendering. No network, no fs.
import yaml from 'js-yaml';
import { validateEntry, SCHEMA, HUB_REPOS } from '../lib.mjs';

export const FIELD_ORDER = Object.keys(SCHEMA.properties);

export const normName = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

export const slugify = (s) =>
  String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');

// Repos that ship many different ports (one per game): a link into one says nothing about
// which port it is, so it must never be used to dedupe or identify an entry.
export { HUB_REPOS };

// owner/repo for a github.com or codeberg.org URL, lowercased; null otherwise (and for hubs).
export function repoKey(url) {
  const m = /^https?:\/\/(?:www\.)?(github\.com|codeberg\.org)\/([^/?#]+)\/([^/?#]+)/i.exec(String(url));
  if (!m) return null;
  const repo = m[3].replace(/\.git$/i, '');
  if (['orgs', 'users', 'sponsors', 'settings', 'topics', 'search'].includes(m[2].toLowerCase())) return null;
  const key = `${m[1].toLowerCase()}/${m[2].toLowerCase()}/${repo.toLowerCase()}`;
  return HUB_REPOS.has(key) ? null : key;
}

export const githubRepo = (url) => {
  const k = repoKey(url);
  return k && k.startsWith('github.com/') ? k.slice('github.com/'.length) : null;
};

export function sidequestKey(url) {
  const m = /sidequestvr\.com\/app\/(\d+)/i.exec(String(url));
  return m ? `sidequest/${m[1]}` : null;
}

// Every identity an entry can be matched on: its name, and each repo/app it links to.
export function entryKeys(entry) {
  const keys = new Set([`name:${normName(entry.name)}`]);
  for (const u of [entry.download_url, entry.source_url, entry.homepage]) {
    if (!u) continue;
    const k = repoKey(u) ?? sidequestKey(u);
    if (k) keys.add(k);
  }
  return keys;
}

export function buildIndex(ports) {
  const index = new Map();
  for (const p of ports) for (const k of entryKeys(p)) index.set(k, p.slug);
  return index;
}

// Slug of the existing entry a candidate already is, or null. Matches on any URL the
// candidate carries (repo / SideQuest app) or on its title as a port name.
export function matchExisting(index, candidate) {
  for (const u of candidate.urls ?? []) {
    const k = repoKey(u) ?? sidequestKey(u);
    if (k && index.has(k)) return index.get(k);
  }
  if (candidate.title) {
    const k = `name:${normName(candidate.title)}`;
    if (index.has(k)) return index.get(k);
  }
  return null;
}

export const normVersion = (v) =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/^(release[-_ ]?|version[-_ ]?|v)/, '');

// A release is a bump when its tag differs from the recorded version and it is not older.
export function isVersionBump(entry, release) {
  if (!release?.tag) return false;
  if (normVersion(release.tag) === normVersion(entry.version)) return false;
  return !release.date || release.date >= entry.version_date;
}

// Rewrite only the version/version_date/last_checked lines so a human-edited file keeps its layout.
export function applyBump(text, { version, version_date, last_checked }) {
  const set = (src, key, val) => {
    const re = new RegExp(`^${key}:.*$`, 'm');
    if (!re.test(src)) throw new Error(`no ${key}: line to update`);
    return src.replace(re, `${key}: ${JSON.stringify(val)}`);
  };
  return set(set(set(text, 'version', version), 'version_date', version_date), 'last_checked', last_checked);
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
export const extractUrls = (text) => [
  ...new Set((String(text).match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ''))),
];

const canon = (u) =>
  String(u)
    .trim()
    .replace(/^http:/i, 'https:')
    .replace(/\/+$/, '')
    .toLowerCase();

// A URL the model wrote is acceptable only if the source material contained it, or it is
// the /releases/latest page of a repo the source material linked. Stops invented links.
export function urlIsGrounded(url, groundUrls) {
  const c = canon(url);
  const ground = new Set(groundUrls.map(canon));
  if (ground.has(c)) return true;
  const latest = /^(https:\/\/(?:github\.com|codeberg\.org)\/[^/]+\/[^/]+)\/releases(?:\/latest)?$/.exec(c);
  if (latest) return groundUrls.some((g) => repoKey(g) && repoKey(g) === repoKey(latest[1]));
  return false;
}

const today = () => new Date().toISOString().slice(0, 10);
const NOT_A_DOWNLOAD =
  /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be|discord\.(gg|com)|reddit\.com|x\.com|twitter\.com)\//i;

// Model output → schema entry. Returns { entry } or { error }. The bot-owned fields
// (added_by, discovered_via, last_checked) are set here, never taken from the model.
export function finalizeEntry(raw, candidate, { date = today() } = {}) {
  if (!raw || typeof raw !== 'object') return { error: 'no entry' };
  const entry = {};
  for (const k of FIELD_ORDER) {
    const v = raw[k];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0 && k !== 'known_bugs') continue;
    entry[k] = v;
  }
  delete entry.images;
  delete entry.no_image;
  delete entry.reviews;
  entry.known_bugs = Array.isArray(raw.known_bugs) ? raw.known_bugs.filter(Boolean) : [];
  if (entry.authors) entry.authors = entry.authors.map((a) => (a.url ? a : { name: a.name }));
  entry.added_by = 'bot';
  entry.discovered_via = candidate.source_url;
  entry.last_checked = date;
  if (entry.version != null) entry.version = String(entry.version);
  if (entry.version_date > date) entry.version_date = date;

  const ground = [...(candidate.urls ?? []), candidate.source_url];
  // A source drop or forum post has no separate download page: the source page is where you get it.
  if (!entry.download_url && entry.source_url) entry.download_url = entry.source_url;
  // Sources with no release date (a hub catalog, a store page) date the entry to when it was seen.
  if (!entry.version_date) entry.version_date = candidate.date || date;
  // A video, chat or forum-thread link is coverage, not somewhere to get the port: no release yet.
  if (NOT_A_DOWNLOAD.test(entry.download_url ?? ''))
    return { error: `download_url ${entry.download_url} is not a download page (unreleased?)` };
  // A pinned release-tag link goes stale on the next release; the bump check keeps `version` current.
  const tagged = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/releases\/(?:tag\/[^/]+|download\/.+)$/i.exec(
    entry.download_url ?? '',
  );
  if (tagged) entry.download_url = `${tagged[1]}/releases/latest`;
  for (const k of ['download_url', 'source_url', 'homepage']) {
    if (entry[k] && !urlIsGrounded(entry[k], ground)) {
      if (k === 'homepage') delete entry.homepage;
      else return { error: `${k} ${entry[k]} not present in the source material` };
    }
  }
  for (const a of entry.authors ?? []) if (a.url && !urlIsGrounded(a.url, ground)) delete a.url;

  const ordered = Object.fromEntries(FIELD_ORDER.filter((k) => k in entry).map((k) => [k, entry[k]]));
  const errors = validateEntry(ordered);
  return errors.length ? { error: `schema: ${errors.join('; ')}` } : { entry: ordered };
}

// Quote every scalar that could be mis-typed (versions, dates) the way CONTRIBUTING asks.
export function toYaml(entry) {
  const ordered = Object.fromEntries(
    [...FIELD_ORDER.filter((k) => k in entry), ...Object.keys(entry).filter((k) => !FIELD_ORDER.includes(k))].map(
      (k) => [k, entry[k]],
    ),
  );
  return yaml
    .dump(ordered, { lineWidth: -1, quotingType: '"', forceQuotes: false, noRefs: true })
    .replace(/^(version|version_date|last_checked): (?!")(.*)$/gm, (_, k, v) => `${k}: ${JSON.stringify(v)}`);
}

export function uniqueSlug(name, taken) {
  const base = slugify(name) || 'port';
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}
