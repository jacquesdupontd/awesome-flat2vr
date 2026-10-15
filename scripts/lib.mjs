import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import yaml from 'js-yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const ROOT = new URL('..', import.meta.url).pathname;

const schema = JSON.parse(readFileSync(join(ROOT, 'schema/port.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const check = ajv.compile(schema);

// Repos that ship many different ports, one per game. Kept here (not in discover/core.mjs)
// so the validator has no dependency on the bot; core re-exports it.
export const HUB_REPOS = new Set(['github.com/rayrod-tv/mvrh']);

// Validate one parsed entry. Returns [] when valid, else human-readable errors.
export function validateEntry(data) {
  if (check(data)) return data.version_date > data.last_checked ? ['version_date is after last_checked'] : [];
  return check.errors.map((err) => {
    const extra = err.params?.additionalProperty ? ` '${err.params.additionalProperty}'` : '';
    return `${err.instancePath || '(root)'} ${err.message}${extra}`;
  });
}

export const SCHEMA = schema;

// Validate every ports/*.yml under `dir`. Returns { ports, errors }; errors are
// human-readable strings prefixed with the offending file.
export function loadPorts(dir = join(ROOT, 'ports'), imageRoot = ROOT) {
  const ports = [];
  const errors = [];
  const files = readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .sort();
  for (const file of files) {
    const where = `ports/${file}`;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*\.yml$/.test(file)) {
      errors.push(`${where}: filename must be <kebab-case-slug>.yml`);
      continue;
    }
    let data;
    try {
      data = yaml.load(readFileSync(join(dir, file), 'utf8'), { schema: yaml.JSON_SCHEMA });
    } catch (e) {
      errors.push(`${where}: invalid YAML: ${e.message.split('\n')[0]}`);
      continue;
    }
    if (!check(data)) {
      for (const err of check.errors) {
        const path = err.instancePath || '(root)';
        const extra = err.params?.additionalProperty ? ` '${err.params.additionalProperty}'` : '';
        const allowed = err.params?.allowedValues ? ` (one of: ${err.params.allowedValues.join(', ')})` : '';
        errors.push(`${where}: ${path} ${err.message}${extra}${allowed}`);
      }
      continue;
    }
    if (data.version_date > data.last_checked) {
      errors.push(`${where}: version_date is after last_checked`);
    }
    const slug = basename(file, '.yml');
    const imaged = new Set((data.images ?? []).map((i) => i.game));
    const noImage = new Set(data.no_image ?? []);
    for (const game of data.no_image ?? []) {
      if (!data.games.includes(game)) errors.push(`${where}: no_image lists '${game}', which is not in games`);
      if (imaged.has(game)) errors.push(`${where}: '${game}' has an image and is also listed in no_image`);
    }
    for (const game of data.games) {
      if (!imaged.has(game) && !noImage.has(game))
        errors.push(`${where}: no image for game '${game}' (run: node scripts/enrich.mjs ${slug})`);
    }
    for (const img of data.images ?? []) {
      if (!data.games.includes(img.game)) errors.push(`${where}: image for '${img.game}', which is not in games`);
      if (!img.file.startsWith(`images/${slug}/`)) {
        errors.push(`${where}: image ${img.file} must live under images/${slug}/`);
      } else if (!existsSync(join(imageRoot, img.file))) {
        errors.push(`${where}: image ${img.file} does not exist`);
      }
    }
    ports.push({ slug: basename(file, '.yml'), ...data });
  }
  const seen = new Map();
  for (const p of ports) {
    const key = p.name.toLowerCase();
    if (seen.has(key)) errors.push(`ports/${p.slug}.yml: duplicate name '${p.name}' (also ports/${seen.get(key)}.yml)`);
    seen.set(key, p.slug);
  }
  // Two entries for one repo are the same port filed twice (except hub repos that ship one
  // port per game, like RaYRoD-TV/MVRH).
  const repos = new Map();
  for (const p of ports) {
    const m = /^https?:\/\/(?:www\.)?(github\.com|gitlab\.com|codeberg\.org)\/([^/?#]+\/[^/?#]+)/i.exec(p.download_url);
    if (!m) continue;
    const repo = `${m[1]}/${m[2]}`.toLowerCase().replace(/\.git$/, '');
    if (HUB_REPOS.has(repo)) continue;
    if (repos.has(repo))
      errors.push(`ports/${p.slug}.yml: same download repo as ports/${repos.get(repo)}.yml (${repo}); merge them`);
    repos.set(repo, p.slug);
  }
  // Unreferenced image files are stale leftovers (only checked for the real index).
  if (dir === join(ROOT, 'ports') && existsSync(join(imageRoot, 'images'))) {
    const used = new Set(ports.flatMap((p) => (p.images ?? []).map((i) => i.file)));
    for (const d of readdirSync(join(imageRoot, 'images'))) {
      if (d.startsWith('.')) continue;
      for (const f of readdirSync(join(imageRoot, 'images', d))) {
        if (!f.startsWith('.') && !used.has(`images/${d}/${f}`))
          errors.push(`images/${d}/${f}: not referenced by any port`);
      }
    }
  }
  return { ports, errors };
}
