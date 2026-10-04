// Markdown tables of run.mjs outputs, for the job summary.
import fs from 'node:fs';
const med = (a) => { const s = a.filter((x) => typeof x === 'number').sort((x, y) => x - y); return s.length ? s[s.length >> 1] : '-'; };
const sum = (a) => Math.round(a.filter((x) => typeof x === 'number').reduce((x, y) => x + y, 0));
for (const file of process.argv.slice(2)) {
  const { engine, results } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const a = results.find((r) => r.adapter)?.adapter ?? {};
  console.log(`\n### ${engine} — ${a.vendor ?? '?'} ${a.architecture ?? ''} ${a.description ?? ''}\n`);
  console.log('| mode | state | compile async ms | sync first draw ms | first draw ms | 384 draws ms | 16 full quads ms | pixel | fatal |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    if (r.mode === 'spec') {
      const g = (n) => r.results?.find((x) => x.state === n);
      for (const n of ['modulate', 'lit']) { const x = g(n); if (x) console.log(`| spec | ${n} (${x.bytes} B) | ${x.asyncCompileMs} | ${x.syncFirstDrawMs} | - | ${x.steadyMs} | ${x.quadsMs} | ${x.px} | |`); }
      const rnd = (r.results ?? []).filter((x) => x.state.startsWith('random'));
      console.log(`| spec | ${rnd.length} random, median | ${med(rnd.map((x) => x.asyncCompileMs))} | ${med(rnd.map((x) => x.syncFirstDrawMs))} | - | ${med(rnd.map((x) => x.steadyMs))} | ${med(rnd.map((x) => x.quadsMs))} | | ${r.fatal ?? ''} |`);
      console.log(`| spec | all ${r.parallelWarmupCount ?? '?'} at once (createRenderPipelineAsync) | ${r.parallelWarmupMs ?? '-'} total | sum of sync: ${sum((r.results ?? []).map((x) => x.syncFirstDrawMs))} | | | | | |`);
    } else {
      console.log(`| ${r.mode} | (${r.bytes ?? '?'} B) | ${r.asyncCompileMs ?? '-'} | ${r.syncFirstDrawMs ?? '-'} | | | | | ${r.fatal ?? ''} |`);
      for (const x of r.results ?? []) console.log(`| ${r.mode} | ${x.state} | | | ${x.firstDrawMs} | ${x.steadyMs} | ${x.quadsMs} | ${x.px} | |`);
    }
    if (r.errors?.length) console.log(`\n${r.mode} uncaptured errors: ${r.errors.slice(0, 3).join(' / ')}\n`);
    if (r.lost) console.log(`\n${r.mode} device lost: ${r.lost}\n`);
  }
}
