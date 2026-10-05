import createCore from '/core/melee_core_web.js';
import {fakeGPU} from './fake-gpu.mjs';

// WORKERFS's lazy reader, served only over loopback. No full-disc copy in browser RAM.
const slice = (start, end) => ({size: end - start,
  slice(a, b) { return slice(start + a, Math.min(end, start + b)); }, start, end});
globalThis.FileReaderSync = class {
  readAsArrayBuffer(blob) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/disc?start=${blob.start}&end=${blob.end}`, false);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    if (xhr.status !== 200) throw new Error(`disc read: ${xhr.status}`);
    if (xhr.response.byteLength !== blob.end - blob.start) throw new Error('short disc response');
    return xhr.response;
  }
};

globalThis.run = async ({size, trace, attached, profile, regions = false, memory = false}) => {
  const logs = [];
  let last = 0;
  const gpu = fakeGPU();
  const core = await createCore({
    print: line => logs.push(line), printErr: line => logs.push(line),
    gxWebgpu: gpu,
    heartbeat(r) {
      if (r < 0) return;
      if (r !== last + 1) throw new Error(`nonsequential retrace ${r}`);
      last = r;
      if (memory && r === 1638) core._emulator_memory_begin();
      if (memory && r === 2400) core._emulator_memory_end();
      if (regions && r === 1638) core._emulator_regions_begin();
      if (regions && r === 2400) core._emulator_regions_end();
      if (profile && r === 1638) console.profile('inmatch');
      if (profile && r === 2400) console.profileEnd('inmatch');
    }
  });
  const fs = core.FS;
  fs.mkdir('/disc');
  const file = Object.assign(slice(0, size), {name: 'disc.iso', lastModifiedDate: new Date(0)});
  fs.mount(fs.filesystems.WORKERFS, {files: [file]}, '/disc');
  fs.mkdir('/work'); fs.mkdir('/work/card');
  fs.writeFile('/work/script.txt', await (await fetch('/script')).text());
  if (attached && core._gx_webgpu_attach() !== 1) throw new Error('renderer attach failed');
  const exit = core.callMain(['--iso', '/disc/disc.iso', '--headless', '--fast', '--frames', '2400',
    '--time-base', '1', '--volume', '0', '--script', '/work/script.txt', '--card-dir', '/work/card',
    '--state-trace', trace ? '/work/trace.csv' : '', '--sim-times', '/work/times.csv']);
  if (gpu.failure || gpu.firstFailure) throw new Error(gpu.failure || gpu.firstFailure);
  if (exit && exit !== 0) throw new Error(`core exit ${exit} at retrace ${last}: ${logs.slice(-12).join(' | ')}`);
  if (last !== 2400 || !logs.some(l => l.includes('match_frame=762 (retraces=2400)')))
    throw new Error(`reference match window not reached (${last}): ${logs.slice(-4).join(' | ')}`);
  const regionLogs = logs.filter(l => l.startsWith('EMULATOR_REGIONS '));
  if (regions && regionLogs.length !== 1) throw new Error('region counter did not report exactly once');
  const measured = regions ? JSON.parse(regionLogs[0].slice('EMULATOR_REGIONS '.length)) : null;
  if (regions && !measured.regions.some(r => r.calls > 0)) throw new Error('region counters measured zero');
  const memoryLogs = logs.filter(l => l.startsWith('EMULATOR_MEMORY '));
  if (memory && memoryLogs.length !== 1) throw new Error('memory counter did not report exactly once');
  const memoryCounts = memory ? JSON.parse(memoryLogs[0].slice('EMULATOR_MEMORY '.length)) : null;
  if (memory && !memoryCounts.calls) throw new Error('memory counters measured zero');
  return {memory: memoryCounts, regions: measured, trace: trace ? fs.readFile('/work/trace.csv', {encoding: 'utf8'}) : null,
    times: fs.readFile('/work/times.csv', {encoding: 'utf8'}), retraces: last};
};

onmessage = async ({data}) => {
  try { postMessage({result: await globalThis.run(data)}); }
  catch (error) { postMessage({error: String(error.stack || error)}); }
};
