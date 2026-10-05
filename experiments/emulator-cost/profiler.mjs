const timeout = (promise, ms, label) => Promise.race([promise,
  new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    timer.unref();
  })]);

// Attach after navigation, including to workers that already exist. Do not enable Debugger.
export async function attachProfiler(page, enabled) {
  const cdp = await page.context().newCDPSession(page);
  let id = 0, started = 0, finished = 0;
  const pending = new Map();
  let readyResolve, readyReject, profileResolve;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const profile = new Promise(resolve => { profileResolve = resolve; });
  const send = (sessionId, method, params = {}) => new Promise((resolve, reject) => {
    const commandId = ++id;
    pending.set(commandId, {resolve, reject});
    cdp.send('Target.sendMessageToTarget', {
      sessionId, message: JSON.stringify({id: commandId, method, params}),
    }).catch(reject);
  });
  cdp.on('Target.receivedMessageFromTarget', ({message}) => {
    const event = JSON.parse(message);
    if (event.id && pending.has(event.id)) {
      const p = pending.get(event.id); pending.delete(event.id);
      if (event.error) p.reject(new Error(JSON.stringify(event.error))); else p.resolve(event.result);
    }
    if (event.method === 'Profiler.consoleProfileStarted' && event.params.title === 'inmatch') started++;
    if (event.method === 'Profiler.consoleProfileFinished' && event.params.title === 'inmatch') {
      finished++; profileResolve(event.params.profile);
    }
  });
  cdp.on('Target.attachedToTarget', async ({sessionId, targetInfo}) => {
    try {
      if (targetInfo.type !== 'worker') return;
      if (enabled) {
        await send(sessionId, 'Profiler.enable');
        await send(sessionId, 'Profiler.setSamplingInterval', {interval: 100});
      }
      await send(sessionId, 'Runtime.runIfWaitingForDebugger');
      readyResolve();
    } catch (error) { readyReject(error); }
  });
  await cdp.send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: true, flatten: false});
  await timeout(ready, 10000, 'no worker profiler session attached');
  return {async result() {
    const result = await timeout(profile, 10000, `no console profile received (started=${started}, finished=${finished})`);
    if (started !== 1 || finished !== 1 || !result.samples?.length)
      throw new Error(`profiler measured no samples (started=${started}, finished=${finished})`);
    return result;
  }};
}
