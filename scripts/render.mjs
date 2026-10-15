// README table: one row per game, sorted by game. A game with several ports lists them all in its row.
const PLATFORM = { pcvr: 'PCVR', standalone: 'Standalone', both: 'PCVR + Standalone' };
const STATUS = { alpha: '🧪 alpha', beta: '🚧 beta', stable: '✅ stable', abandoned: '💀 abandoned' };

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const attr = (s) => cell(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const authors = (p) => p.authors.map((a) => (a.url ? `[${cell(a.name)}](${a.url})` : cell(a.name))).join(', ');
const reviewLinks = (p) => (p.reviews ?? []).map((r) => `[▶ ${cell(r.channel)}](${r.url})`);

// One entry per game: { game, ports: [port, ...], image }. A port covering several games appears
// under each of them; the game's art is the first port's image for it.
export function rows(ports) {
  const byGame = new Map();
  for (const p of ports) {
    for (const game of p.games) {
      const g = byGame.get(game) ?? { game, ports: [], image: undefined };
      g.ports.push(p);
      g.image ??= (p.images ?? []).find((i) => i.game === game);
      byGame.set(game, g);
    }
  }
  for (const g of byGame.values()) g.ports.sort((a, b) => a.name.localeCompare(b.name));
  const key = (s) => s.toLowerCase().replace(/^the /, '');
  return [...byGame.values()].sort((a, b) => key(a.game).localeCompare(key(b.game)));
}

// Four columns, not seven: GitHub caps images at the cell width, so every extra column
// shrinks the game art. Port, version and author share one cell; platform, status and
// known bugs share another. With several ports in a row, each block is separated by a blank
// line and the platform cell is prefixed with the port's name so the blocks stay aligned.
export function render(ports) {
  const lines = rows(ports).map(({ game, ports: ps, image }) => {
    const many = ps.length > 1;
    const portCell = ps
      .map(
        (p) =>
          `[${cell(p.name)}](${p.source_url})<br>by ${authors(p)}<br>Latest: [${cell(p.version)}](${p.download_url}) (${p.version_date})`,
      )
      .join('<br><br>');
    const platformCell = ps
      .map((p) =>
        [
          many ? `**${cell(p.name)}**` : '',
          PLATFORM[p.platform],
          STATUS[p.status],
          p.known_bugs?.length ? `${p.known_bugs.length} known bug${p.known_bugs.length > 1 ? 's' : ''}` : '',
        ]
          .filter(Boolean)
          .join('<br>'),
      )
      .join('<br><br>');
    const revs = ps.flatMap(reviewLinks);
    return [
      `${image ? `<img src="${image.file}" width="300" alt="${attr(game)}"><br>` : ''}**${cell(game)}**`,
      portCell,
      platformCell,
      revs.join('<br>') || '—',
    ].join(' | ');
  });
  return ['| Game | Port | Platform | Reviews |', '|---|---|---|---|', ...lines.map((l) => `| ${l} |`)].join('\n');
}
