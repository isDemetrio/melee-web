/**
 * The page's side of the disc cache: one worker, one identified message per operation.
 *
 * The fake worker in `fakes/fakeWorkerPort.ts` runs the **real** request handler from
 * `opfs-worker.ts` over the fake file system, so what is exercised here is the whole conversation
 * -- the ids, the fields, the replies, the errors -- with only the worker's own plumbing replaced.
 * What is asserted:
 *
 *  - the store asks for exactly the operation the interface promises, with the fields the worker
 *    validates;
 *  - replies are matched by id, so two requests answered out of order land on their own promises
 *    (this is the whole reason the protocol carries ids);
 *  - a refusal keeps its name, and an answer that is not the shape the operation promised is
 *    refused rather than handed on;
 *  - a worker error, a message that is not a reply, and a worker that cannot be posted to all
 *    reject what is in flight instead of leaving a promise pending forever, and the next request
 *    gets a fresh worker;
 *  - one worker serves every identity, and `close()` stops it.
 *
 * In a browser each of these replies crosses a real `postMessage` and is structured-cloned. That
 * is the one thing this file cannot show; it is why the worker answers with a `File` at all (a
 * `File` is cloneable) and why the value checks here are the same ones the browser would need.
 */

import { describe, expect, it } from 'vitest';
import type { DiscStore } from '../../src/spike/disc-cache.js';
import { OpfsDiscStore, answerDiscStoreRequest } from '../../src/spike/opfs-worker.js';
import { opfsDiscStoreFactory, type OpfsDiscStoreFactory } from '../../src/spike/opfs-store.js';
import { fakeLocks, fakeSyncOpfsRoot } from './fakes/fakeSyncOpfs.js';
import { FakeWorkerPort } from './fakes/fakeWorkerPort.js';

const IDENTITY = 'a1'.repeat(32);
const OTHER = 'b2'.repeat(32);

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    release = () => {
      settle(undefined);
    };
  });
  return { promise, resolve: release };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10_000 && !predicate(); attempt++) await Promise.resolve();
  if (!predicate()) throw new Error('the awaited condition never became true');
}

interface Setup {
  readonly port: FakeWorkerPort;
  readonly factory: OpfsDiscStoreFactory;
  readonly disc: DiscStore;
  /** How many workers the factory has spawned so far. */
  workers(): number;
}

function setup(): Setup {
  const root = fakeSyncOpfsRoot();
  const locks = fakeLocks();
  const store = new OpfsDiscStore({ root: async () => root, locks: locks.request });
  const port = new FakeWorkerPort((request) => answerDiscStoreRequest(store, request));
  let spawned = 0;
  const factory = opfsDiscStoreFactory({
    worker: () => {
      spawned++;
      return port;
    },
  });
  return { port, factory, disc: factory(IDENTITY), workers: () => spawned };
}

describe('the page side of the disc cache', () => {
  it('asks for exactly the operation the interface promises, with an id', async () => {
    const { disc, port } = setup();
    await disc.append(0, bytes(1, 2, 3, 4));
    await disc.truncate(2);
    expect(Array.from(await disc.read(0, 2))).toEqual([1, 2]);
    expect(await disc.length()).toBe(2);
    expect((await disc.file()).name).toBe('melee-ntsc102.iso');
    await disc.remove();
    expect(await disc.length()).toBe(0);
    expect(port.requests).toEqual([
      { id: 1, op: 'append', identity: IDENTITY, offset: 0, bytes: bytes(1, 2, 3, 4) },
      { id: 2, op: 'truncate', identity: IDENTITY, size: 2 },
      { id: 3, op: 'read', identity: IDENTITY, offset: 0, length: 2 },
      { id: 4, op: 'length', identity: IDENTITY },
      { id: 5, op: 'file', identity: IDENTITY },
      { id: 6, op: 'remove', identity: IDENTITY },
      { id: 7, op: 'length', identity: IDENTITY },
    ]);
  });

  it('matches replies to requests by id, even when they arrive out of order', async () => {
    const { disc, port } = setup();
    await disc.append(0, bytes(1, 2, 3, 4));
    const held = deferred();
    port.gate = (request) => (request.op === 'length' ? held.promise : null);
    const length = disc.length();
    const read = disc.read(0, 4);
    // The read is answered while the length is still held: without ids, one of these two promises
    // would be handed the other one's answer.
    expect(Array.from(await read)).toEqual([1, 2, 3, 4]);
    expect(port.requests.map((request) => request.id)).toEqual([1, 2, 3]);
    held.resolve();
    expect(await length).toBe(4);
  });

  it('gives back the refusal the worker made, with its own name', async () => {
    const { disc } = setup();
    const error = await disc.append(4, bytes(1, 2)).then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );
    expect(error?.message).toMatch(/refusing to write 2 bytes at 4: the cached disc is 0 bytes/);
    expect(error?.name).toBe('OpfsDiscStoreError');
  });

  it('refuses an answer that is not the shape the operation promised', async () => {
    const { disc, port } = setup();
    const held = deferred();
    port.gate = () => held.promise;
    const length = disc.length();
    await until(() => port.requests.length === 1);
    port.emitMessage({ id: 1, ok: true, value: 'four' });
    await expect(length).rejects.toThrow(/answered length with string, not with the value it promised/);
  });

  it('refuses a File reply that is not a File', async () => {
    const { disc, port } = setup();
    const held = deferred();
    port.gate = () => held.promise;
    const file = disc.file();
    await until(() => port.requests.length === 1);
    port.emitMessage({ id: 1, ok: true, value: new Blob([bytes(1, 2).slice()]) });
    await expect(file).rejects.toThrow(/answered file with object, not with the value it promised/);
  });

  it('rejects everything in flight when the worker fails, and starts a new one after', async () => {
    const { disc, port, workers } = setup();
    const held = deferred();
    port.gate = () => held.promise;
    const length = disc.length();
    const read = disc.read(0, 4);
    await until(() => port.requests.length === 2);
    port.fail('the worker died');
    await expect(length).rejects.toThrow(/the disc cache worker failed: the worker died/);
    await expect(read).rejects.toThrow(/the worker died/);
    expect(port.terminated).toBe(true);
    // The next request gets a fresh worker rather than waiting for an answer that cannot come.
    port.gate = null;
    expect(await disc.length()).toBe(0);
    expect(workers()).toBe(2);
  });

  it('fails the requests in flight when the worker sends something that is not a reply', async () => {
    const { disc, port } = setup();
    const held = deferred();
    port.gate = () => held.promise;
    const length = disc.length();
    await until(() => port.requests.length === 1);
    port.emitMessage({ nonsense: true });
    await expect(length).rejects.toThrow(/sent a message that is not a reply/);
  });

  it('ignores a reply to a request nobody is waiting for', async () => {
    const { disc, port } = setup();
    port.emitMessage({ id: 99, ok: true, value: 3 });
    expect(await disc.length()).toBe(0);
  });

  it('does not leave a promise pending when the worker cannot be posted to', async () => {
    const { disc, port } = setup();
    port.postMessage = () => {
      throw new Error('the port is closed');
    };
    await expect(disc.length()).rejects.toThrow(/could not be asked for length: Error: the port is closed/);
  });

  it('reports a worker that cannot be created at all', async () => {
    const factory = opfsDiscStoreFactory({
      worker: () => {
        throw new Error('no module workers here');
      },
    });
    await expect(factory(IDENTITY).length()).rejects.toThrow(/no module workers here/);
  });

  it('serves every identity from one worker, and close() stops it', async () => {
    const { factory, port, workers } = setup();
    const one = factory(IDENTITY);
    const other = factory(OTHER);
    await one.append(0, bytes(1, 2));
    await other.append(0, bytes(3, 4));
    expect(workers()).toBe(1);
    expect(await one.length()).toBe(2);
    expect(await other.length()).toBe(2);
    factory.close();
    expect(port.terminated).toBe(true);
  });

  it('rejects what is in flight when the factory is closed', async () => {
    const { disc, factory, port } = setup();
    const held = deferred();
    port.gate = () => held.promise;
    const length = disc.length();
    await until(() => port.requests.length === 1);
    factory.close();
    await expect(length).rejects.toThrow(/the disc cache worker was closed/);
  });
});
