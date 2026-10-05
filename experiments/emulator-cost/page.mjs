const worker = new Worker('/worker.mjs', {type: 'module'});
globalThis.run = opts => new Promise((resolve, reject) => {
  worker.onerror = event => reject(new Error(event.message));
  worker.onmessage = ({data}) => data.error ? reject(new Error(data.error)) : resolve(data.result);
  worker.postMessage(opts);
});
