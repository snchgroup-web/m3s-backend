const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const update = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/programAccessCurrentStatus.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'artifacts/M3S_BOUSSOLE_TRILINGUE_V3_1_2026-09-13.html'), 'utf8');
const pattern = /(<script id="data" type="application\/json">)([\s\S]*?)(<\/script>)/;
const match = source.match(pattern);
if (!match) throw new Error('Missing source data');
const data = JSON.parse(match[2]);
const date = update.snapshotDate;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid snapshot date');
data.version = '3.3';
data.date = date;
const historic = { type: 'prose', title: {
  FR: 'Archive datée du 13 septembre 2026', DE: 'Archiv vom 13. September 2026', EN: 'Archive dated 13 September 2026'
}, body: {
  FR: 'Les états ci-dessous sont historiques. Le point courant Accès M3S du 27 septembre distingue les livraisons réelles et les suites ouvertes. Aucun compteur global recalculé.',
  DE: 'Die folgenden Stände sind historisch. Der aktuelle M3S-Zugangsstand vom 27. September trennt reale Lieferungen von offenen Schritten. Keine globale Kennzahl neu berechnet.',
  EN: 'The states below are historical. The current M3S Access status of 27 September separates live deliveries from open next steps. No global count recalculated.'
}};
for (const section of data.sections) section.blocks.unshift(historic);
data.sections.splice(1, 0, update);
const labels = {
  FR: { date: '27 septembre 2026 · V3.3', foot: 'Point documentaire daté ; livraisons réelles distinguées des archives.', facts: ['Acquis réels', 'Périmètre vérifié', 'Suite ouverte'], read: 'Lecture documentaire · V3.3' },
  DE: { date: '27. September 2026 · V3.3', foot: 'Datierter Dokumentationsstand; reale Lieferungen von Archiven getrennt.', facts: ['Reale Ergebnisse', 'Geprüfter Umfang', 'Offene Schritte'], read: 'Dokumentarische Ansicht · V3.3' },
  EN: { date: '27 September 2026 · V3.3', foot: 'Dated documentary update; live deliveries distinguished from archives.', facts: ['Live progress', 'Verified scope', 'Open next steps'], read: 'Documentary view · V3.3' }
};
for (const lang of ['FR', 'DE', 'EN']) {
  Object.assign(data.ui[lang], labels[lang], { factBody: [update.intro[lang], update.summary[lang], update.nextStep[lang]] });
}
data.sources.push(['S14', 'Point de reprise GED 27-09-2026 ; mise en service §14.51 ; PR backend 106, frontend 336 ; vérification réelle.', '']);
const cell = value => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
let markdown = '# Boussole V3.3 - ' + date + '\n\n';
for (const lang of ['FR', 'DE', 'EN']) {
  markdown += `## ${lang} - ${update.title[lang]}\n\n${update.intro[lang]}\n\n`;
  for (const block of update.blocks) {
    markdown += `### ${block.title[lang]}\n\n`;
    if (block.type === 'prose') markdown += block.body[lang] + '\n\n';
    else markdown += '| ' + block.heads[lang].map(cell).join(' | ') + ' |\n|---|---|---|\n' + block.rows.map(row => '| ' + row.map(c => cell(c[lang])).join(' | ') + ' |').join('\n') + '\n\n';
  }
}
markdown += '\n---\n# Archive V3.1 - 13-09-2026\n\n';
const exportStart = 'new Blob(["# 2SG / M3S';
if (!source.includes(exportStart)) throw new Error('Missing export marker');
// Keep the archived template unchanged; apply navigation fixes to the live artifact.
const mobileNavigation = `
<style id="mobile-navigation">
@media screen and (max-width:700px){
  aside{position:sticky;top:0;bottom:auto;z-index:5;overflow:visible;padding:10px 16px}
  .brand{margin-bottom:8px}
  .nav{scroll-padding-inline:8px}
}
</style>
<script id="mobile-navigation-script">
function revealActiveNavigation(){
  if(!window.matchMedia('(max-width:700px)').matches)return;
  const nav=document.getElementById('nav');
  const active=nav&&nav.querySelector('[aria-current="page"]');
  if(!active)return;
  const bounds=nav.getBoundingClientRect(),item=active.getBoundingClientRect();
  nav.scrollTo({left:nav.scrollLeft+item.left-bounds.left-(nav.clientWidth-item.width)/2,behavior:'instant'});
}
window.addEventListener('resize',revealActiveNavigation);
</script>
`;
const renderEnd = 'applyTheme();search();}';
if (!source.includes(renderEnd)) throw new Error('Missing navigation render marker');
const html = source.replace(pattern, (_all, start, _json, end) => start + JSON.stringify(data).replace(/</g, '\\u003c') + end)
  .replace('</head>', mobileNavigation + '</head>')
  .replace(renderEnd, 'applyTheme();search();revealActiveNavigation();}')
  .replace('datetime="2026-09-13"', `datetime="${date}"`)
  .replace('2SG / M3S · V3.1 · 2026-09-13', `2SG / M3S · V3.3 · ${date}`)
  .replace(exportStart, () => 'new Blob([' + JSON.stringify(markdown) + ' + "# 2SG / M3S')
  .replace("a.download='M3S_BOUSSOLE_REFERENCE_TRILINGUE_V3_1_2026-09-13.md'", `a.download='M3S_BOUSSOLE_REFERENCE_TRILINGUE_V3_3_${date}.md'`);
const destination = path.join(root, `artifacts/M3S_BOUSSOLE_TRILINGUE_V3_3_${date}.html`);
fs.writeFileSync(destination, html);
const generated = JSON.parse(html.match(pattern)[2]);
if (JSON.stringify(generated.sections[1]) !== JSON.stringify(update)) throw new Error('Cockpit/Boussole mismatch');
console.log('Artifact generated; current data identical; archives preserved: ' + destination);
