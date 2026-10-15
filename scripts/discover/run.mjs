#!/usr/bin/env node
// Daily Flat2VR discovery: version bumps for indexed GitHub ports + new ports from
// Tate's release-report gists, GitHub, SideQuest and Reddit, committed straight to main.
//
//   node scripts/discover/run.mjs [--dry-run] [--commit] [--notify]
//        [--sources gists,github,sidequest,reddit,x] [--max-extract N] [--no-bumps]
//
// --dry-run   discover + extract, print what would change, write nothing (state included)
// --commit    build, validate, commit the new/bumped entries to main and push origin main.
//             (--pr is kept as a deprecated alias.) Without it, files are written to the
//             working tree only.
// --notify    tg-fyi a summary when something was added or bumped (silent otherwise)
// Env: FLAT2VR_STATE (seen-state dir, default ~/.local/state/flat2vr-bot),
//      FLAT2VR_HC_URL (Healthchecks ping URL; /start, success and /fail are sent).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadPorts, ROOT } from '../lib.mjs';
import {
  applyBump,
  buildIndex,
  entryKeys,
  finalizeEntry,
  githubRepo,
  isVersionBump,
  matchExisting,
  toYaml,
  uniqueSlug,
} from './core.mjs';
import { enrich } from '../enrich.mjs';
import { COLLECTORS, candidateRepo, deadLinks, latestRelease, repoContext, waybackSnapshot } from './sources.mjs';
import { extract } from './extract.mjs';

// Verdicts worth another look on a later run (a transient failure, or a model miss the gate caught).
const RETRY = new Set(['error', 'invalid']);
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const DRY = flag('--dry-run');
const COMMIT = (flag('--commit') || flag('--pr')) && !DRY;
const SOURCES = opt('--sources', 'seeds,mvrh,questports,gists,github,steam,sidequest,discord,youtube,reddit,x')
  .split(',')
  .filter(Boolean);
const MAX_EXTRACT = Number(opt('--max-extract', '25'));
const STATE_DIR = process.env.FLAT2VR_STATE || join(homedir(), '.local/state/flat2vr-bot');
const SEEN_FILE = join(STATE_DIR, 'seen.json');
const TODAY = new Date().toISOString().slice(0, 10);
const HC = process.env.FLAT2VR_HC_URL;

const sh = (cmd, a, o = {}) => execFileSync(cmd, a, { cwd: ROOT, encoding: 'utf8', ...o }).trim();
const git = (...a) => sh('git', a);
const log = (...m) => console.log(...m);

async function ping(suffix = '', body = '') {
  if (!HC || DRY) return;
  try {
    await fetch(`${HC}${suffix}`, { method: 'POST', body });
  } catch (e) {
    console.error(`healthchecks ping failed: ${e.message}`);
  }
}

function loadSeen() {
  try {
    return JSON.parse(readFileSync(SEEN_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveSeen(seen) {
  if (DRY) return;
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 1));
}

// Start every run from a clean origin/main working tree so new entries are deduped
// against what is already published and committed straight on top of it.
function prepareMain() {
  git('fetch', 'origin', '--prune');
  git('checkout', '--force', '-B', 'main', 'origin/main');
  for (const f of git('ls-files', '--others', '--exclude-standard', 'ports/', 'images/').split('\n').filter(Boolean))
    rmSync(join(ROOT, f));
}

// Existing entries rot too: a creator deletes a repo or a whole account (2026-10-10:
// Tensai37's Codeberg account vanished and two entries 404'd the link check). Only a
// provably dead link counts (404/410; unknown is alive). A dead link is swapped for its
// Wayback snapshot and the port marked abandoned; a download nobody can get, with no
// snapshot, removes the entry and its images (a dead port is noise, not history).
async function linkRot(ports, changes) {
  // Acting needs two strikes on different days, so a host that 404s for an afternoon
  // (maintenance, a rename in flight) never costs an entry.
  const strikesFile = join(STATE_DIR, 'rot-strikes.json');
  let strikes;
  try {
    strikes = JSON.parse(readFileSync(strikesFile, 'utf8'));
  } catch {
    strikes = {};
  }
  const next = {};
  for (const p of ports) {
    let dead;
    try {
      dead = await deadLinks(p);
    } catch {
      continue;
    }
    if (!dead.length) continue;
    const days = [...new Set([...(strikes[p.slug] ?? []), TODAY])].slice(-2);
    next[p.slug] = days;
    if (days.length < 2) {
      log(`rot   ${p.slug}: dead link seen (strike 1, acting on a later day): ${dead.join(' ')}`);
      continue;
    }
    const file = join(ROOT, 'ports', `${p.slug}.yml`);
    const snaps = new Map();
    for (const u of dead) {
      const s = await waybackSnapshot(u).catch(() => null);
      if (s) snaps.set(u, s);
    }
    if (dead.includes(p.download_url) && !snaps.has(p.download_url)) {
      if (!DRY) {
        rmSync(file);
        rmSync(join(ROOT, 'images', p.slug), { recursive: true, force: true });
      }
      changes.rotted.push({ slug: p.slug, name: p.name, action: 'removed', dead });
      log(`rot   ${p.slug}: removed (dead, no archive): ${dead.join(' ')}`);
      continue;
    }
    let text = readFileSync(file, 'utf8');
    for (const u of dead) {
      if (snaps.has(u)) text = text.split(u).join(snaps.get(u));
      else if (u === p.homepage) text = text.replace(/^homepage: .*\n/m, '');
      else if (u === p.source_url) text = text.replace(/^source_url: .*$/m, `source_url: ${p.download_url}`);
    }
    text = text.replace(/^status: .*$/m, 'status: abandoned');
    if (!DRY) writeFileSync(file, text);
    changes.rotted.push({ slug: p.slug, name: p.name, action: 'archived', dead });
    log(`rot   ${p.slug}: abandoned, archived links for ${dead.join(' ')}`);
  }
  if (!DRY) {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(strikesFile, JSON.stringify(next, null, 1));
  }
}

async function versionBumps(ports, changes) {
  for (const p of ports) {
    const repo = githubRepo(p.download_url) ?? githubRepo(p.source_url);
    if (!repo || p.status === 'abandoned') continue;
    let rel;
    try {
      rel = await latestRelease(repo);
    } catch (e) {
      changes.warnings.push(`bump check ${p.slug}: ${e.message}`);
      continue;
    }
    if (!isVersionBump(p, rel)) continue;
    const file = join(ROOT, 'ports', `${p.slug}.yml`);
    const next = applyBump(readFileSync(file, 'utf8'), {
      version: rel.tag,
      version_date: rel.date || TODAY,
      last_checked: TODAY,
    });
    if (!DRY) writeFileSync(file, next);
    changes.bumped.push({ slug: p.slug, name: p.name, from: p.version, to: rel.tag, url: rel.url });
    log(`bump  ${p.slug}: ${p.version} -> ${rel.tag}`);
  }
}

async function discover(ports, changes) {
  const seen = loadSeen();
  const index = buildIndex(ports);
  const taken = new Set(ports.map((p) => p.slug));
  const names = ports.map((p) => p.name);
  // One-time legacy migration. The old flow proposed entries in a rolling PR; an entry
  // recorded `added` could sit in a PR that was closed, never merged, so it is in seen-state
  // as added yet never reached main — and `added` is never retried, so it would be suppressed
  // forever. Clear those verdicts once so they are rediscovered and committed on this run.
  // This runs exactly once (guarded by the _legacyHealed sentinel): from the direct-commit
  // cutover on, rollbackAdded guarantees an `added` verdict means the port really is on main,
  // so a port a maintainer later deletes stays deleted instead of being re-added.
  if (!seen._legacyHealed) {
    let healed = 0;
    for (const [id, v] of Object.entries(seen))
      if (id[0] !== '_' && v.result === 'added' && v.slug && !taken.has(v.slug)) {
        delete seen[id];
        healed++;
      }
    seen._legacyHealed = TODAY;
    log(`heal  one-time legacy migration: cleared ${healed} added-but-unpublished verdict(s)`);
    saveSeen(seen);
  }
  const candidates = [];
  for (const s of SOURCES) {
    try {
      const got = await COLLECTORS[s]();
      log(`source ${s}: ${got.length} candidates`);
      candidates.push(...got);
    } catch (e) {
      changes.warnings.push(`source ${s}: ${e.message}`);
      console.error(`source ${s} failed: ${e.message}`);
    }
  }

  let extracted = 0;
  const runKeys = new Set();
  for (const c of candidates) {
    const prior = seen[c.id];
    if (prior && (!RETRY.has(prior.result) || (prior.attempts ?? 1) >= 3)) continue;
    const dup = matchExisting(index, c);
    if (dup) {
      seen[c.id] = { result: 'duplicate', of: dup, at: TODAY };
      continue;
    }
    const repo = c.noEnrich ? null : candidateRepo(c);
    if (repo && runKeys.has(repo)) continue;
    if (extracted >= MAX_EXTRACT) {
      changes.deferred++;
      continue;
    }
    try {
      if (repo) {
        const ctx = await repoContext(repo);
        if (c.needsRelease && !ctx?.release) continue; // re-check tomorrow; no model call spent
        if (ctx) {
          c.text += `\n\n--- Linked repository facts (from the GitHub API) ---\n${ctx.text}`;
          c.urls = [...new Set([...c.urls, ...ctx.urls])];
        }
        runKeys.add(repo);
      }
      extracted++;
      const out = extract(c, names, { date: TODAY });
      if (!out.is_port || out.duplicate_of) {
        seen[c.id] = {
          result: out.duplicate_of ? 'duplicate' : 'rejected',
          of: out.duplicate_of,
          reason: out.reason,
          at: TODAY,
        };
        log(`skip  ${c.title}: ${out.duplicate_of ? `duplicate of ${out.duplicate_of}` : out.reason}`);
        continue;
      }
      const { entry, error } = finalizeEntry(out.entry, c, { date: TODAY });
      if (error) {
        seen[c.id] = { result: 'invalid', reason: error, attempts: (prior?.attempts ?? 0) + 1, at: TODAY };
        log(`drop  ${c.title}: ${error}`);
        continue;
      }
      const dead = await deadLinks(entry);
      if (dead.length) {
        seen[c.id] = {
          result: 'invalid',
          reason: `dead link: ${dead.join(' ')}`,
          attempts: (prior?.attempts ?? 0) + 1,
          at: TODAY,
        };
        log(`drop  ${c.title}: dead link ${dead.join(' ')}`);
        continue;
      }
      const clash = [...entryKeys(entry)].find((k) => index.has(k));
      if (clash) {
        seen[c.id] = { result: 'duplicate', of: index.get(clash), at: TODAY };
        continue;
      }
      const slug = uniqueSlug(entry.name, taken);
      if (!DRY) {
        await enrich(entry, slug, { log });
        // The index requires an image per game; without one the build fails for the whole run.
        if ((entry.images?.length ?? 0) < entry.games.length) {
          seen[c.id] = { result: 'error', error: 'no image found', at: TODAY };
          log(`skip  ${entry.name}: no image found for every game, will retry`);
          rmSync(join(ROOT, 'images', slug), { recursive: true, force: true });
          continue;
        }
        writeFileSync(join(ROOT, 'ports', `${slug}.yml`), toYaml(entry));
      }
      taken.add(slug);
      for (const k of entryKeys(entry)) index.set(k, slug);
      names.push(entry.name);
      changes.added.push({
        slug,
        name: entry.name,
        games: entry.games,
        via: entry.discovered_via,
        url: entry.download_url,
      });
      seen[c.id] = { result: 'added', slug, at: TODAY };
      changes.addedIds.push(c.id);
      log(`add   ${slug}: ${entry.name} (${entry.games.join(', ')}) via ${c.source}`);
      if (DRY) log(toYaml(entry));
    } catch (e) {
      seen[c.id] = {
        result: 'error',
        reason: e.message.slice(0, 300),
        attempts: (prior?.attempts ?? 0) + 1,
        at: TODAY,
      };
      changes.warnings.push(`${c.id}: ${e.message.split('\n')[0]}`);
    } finally {
      saveSeen(seen);
    }
  }
  changes.extracted = extracted;
}

// An image this run downloaded for an entry that was later dropped, renamed or merged is
// left untracked and unreferenced, and the validator rejects the whole build over it.
// Only untracked files are removed: anything already committed is a human's call.
function pruneOrphanImages() {
  const untracked = git('ls-files', '--others', '--exclude-standard', 'images/').split('\n').filter(Boolean);
  if (!untracked.length) return;
  const referenced = new Set(
    readdirSync(join(ROOT, 'ports'))
      .filter((f) => f.endsWith('.yml'))
      .flatMap((f) =>
        [...readFileSync(join(ROOT, 'ports', f), 'utf8').matchAll(/^\s+file: (\S+)$/gm)].map((m) => m[1]),
      ),
  );
  for (const f of untracked)
    if (!referenced.has(f)) {
      rmSync(join(ROOT, f));
      log(`prune ${f}: image not referenced by any port`);
    }
}

// Build + validate, then commit the run's changes straight to main and push. No PR:
// every entry is already `added_by: bot` and credits its source in `discovered_via`,
// and `npm run validate` has to pass locally before the commit is made. If the push
// fails anyway, the caller rolls this run's `added` verdicts back out of seen-state so
// the entries are rediscovered next run instead of being suppressed forever.
function commitToMain() {
  pruneOrphanImages();
  // Match the repo's Prettier style so a human's local commit never trips over a bot-written file.
  sh('npx', ['prettier', '--write', '--log-level', 'warn', 'ports']);
  sh('npm', ['run', '-s', 'build']);
  sh('npm', ['run', '-s', 'validate']);
  git('add', 'ports', 'images', 'README.md', 'data');
  if (!git('status', '--porcelain', '--', 'ports', 'images', 'README.md', 'data')) return null;
  git(
    '-c',
    'user.name=flat2vr-bot',
    '-c',
    'user.email=bot@alastor.space',
    'commit',
    '-m',
    `bot: discovery run ${TODAY}`,
  );
  // prepareMain already reset the clone to a freshly-fetched origin/main, so this is a
  // fast-forward in the common case. A rejected push (a human commit landed in the run
  // window) is not retried in-process — the caller rolls the `added` verdicts back out of
  // seen-state, so the entries are simply rediscovered and published on the next run.
  git('push', 'origin', 'main');
  const sha = git('rev-parse', 'HEAD');
  return `https://github.com/jrejaud/awesome-flat2vr/commit/${sha}`;
}

// A discovery is only durable once it is pushed to main. If publishing throws, drop the
// `added` verdicts recorded during discovery so the next run rediscovers and re-adds them
// (an `added` id is never retried otherwise), and leave the working tree for prepareMain
// to reset. Version bumps need no rollback — they are recomputed from scratch each run.
function rollbackAdded(addedIds) {
  if (!addedIds.length) return;
  const seen = loadSeen();
  let changed = false;
  for (const id of addedIds)
    if (seen[id]) {
      delete seen[id];
      changed = true;
    }
  if (changed) saveSeen(seen);
}

function notify(changes, commitUrl) {
  if (!changes.added.length && !changes.bumped.length && !changes.rotted.length) return;
  const lines = [
    ...changes.added.map((a) => `+ ${a.name} (${a.games.join(', ')})`),
    ...changes.bumped.map((b) => `↑ ${b.name} ${b.from} → ${b.to}`),
    ...changes.rotted.map(
      (r) =>
        `✗ ${r.name}: link dead, ${r.action === 'removed' ? 'removed (no archive)' : 'marked abandoned, archive linked'}`,
    ),
  ];
  if (commitUrl) lines.push('', `Added to the index: ${commitUrl}`);
  if (changes.warnings.length) lines.push(`(${changes.warnings.length} source warning(s) — see the run log)`);
  const title = `Flat2VR index: ${changes.added.length} new, ${changes.bumped.length} updated`;
  try {
    sh('tg-fyi', ['flat2vr-bot', title, lines.join('\n')]);
  } catch (e) {
    console.error(`tg-fyi failed: ${e.message}`);
  }
}

async function main() {
  await ping('/start');
  const changes = { added: [], addedIds: [], bumped: [], rotted: [], warnings: [], deferred: 0, extracted: 0 };
  if (COMMIT) prepareMain();
  const { ports, errors } = loadPorts();
  if (errors.length) throw new Error(`index invalid before run: ${errors.join('; ')}`);
  if (!flag('--no-rot')) await linkRot(ports, changes);
  if (!flag('--no-bumps'))
    await versionBumps(
      ports.filter((p) => !changes.rotted.some((r) => r.slug === p.slug)),
      changes,
    );
  await discover(ports, changes);

  let commitUrl = null;
  if (COMMIT) {
    try {
      commitUrl = commitToMain();
    } catch (e) {
      rollbackAdded(changes.addedIds);
      throw e;
    }
  } else if (!DRY && (changes.added.length || changes.bumped.length)) sh('npm', ['run', '-s', 'build']);

  const summary = {
    at: new Date().toISOString(),
    dry: DRY,
    added: changes.added.map((a) => a.slug),
    bumped: changes.bumped.map((b) => b.slug),
    rotted: changes.rotted.map((r) => `${r.slug}:${r.action}`),
    extracted: changes.extracted,
    deferred: changes.deferred,
    warnings: changes.warnings,
    commit: commitUrl,
  };
  if (!DRY) {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(join(STATE_DIR, 'runs.jsonl'), `${JSON.stringify(summary)}\n`);
  }
  log(JSON.stringify(summary, null, 2));
  if (flag('--notify')) notify(changes, commitUrl);
  // A source that failed is a failed run (Linear comment via the cron card), but whatever
  // the other sources found is already published above.
  if (changes.warnings.some((w) => w.startsWith('source '))) {
    await ping('/fail', changes.warnings.join('\n'));
    process.exitCode = 2;
  } else await ping('', JSON.stringify(summary));
}

if (!existsSync(join(ROOT, 'ports'))) throw new Error(`no ports/ under ${ROOT}`);
main().catch(async (e) => {
  console.error(e.stack ?? e.message);
  await ping('/fail', e.message);
  process.exit(1);
});
