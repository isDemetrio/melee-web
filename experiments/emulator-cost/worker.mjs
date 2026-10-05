import createCore from '/core/melee_core_web.js';
import {fakeGPU} from './fake-gpu.mjs';

// WORKERFS's lazy reader, served only over loopback. No full-disc copy in browser RAM.
const slice = (start, end) => ({size: end - start,
  slice(a, b) { return slice(start + a, Math.min(end, start + b)); }, start, end});
globalThis.FileReaderSync = class {
  readAsArrayBuffer(blob) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/disc?start=${blob.start}&end=${blob.end}`, false);
    xhr.overrideMimeType('text/plain; charset=x-user-defined');
    xhr.send();
    if (xhr.status !== 200) throw new Error(`disc read: ${xhr.status}`);
    return Uint8Array.from(xhr.responseText, c => c.charCodeAt(0) & 255).buffer;
  }
};

globalThis.run = async ({size, trace, attached, profile}) => {
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
  if (exit && exit !== 0) throw new Error(`core exit ${exit}`);
  if (last !== 2400 || !logs.some(l => l.includes('match_frame=762 (retraces=2400)')))
    throw new Error('reference match window not reached');
  return {trace: trace ? fs.readFile('/work/trace.csv', {encoding: 'utf8'}) : null,
    times: fs.readFile('/work/times.csv', {encoding: 'utf8'}), retraces: last};
};

onmessage = async ({data}) => {
  try { postMessage({result: await globalThis.run(data)}); }
  catch (error) { postMessage({error: String(error.stack || error)}); }
};
