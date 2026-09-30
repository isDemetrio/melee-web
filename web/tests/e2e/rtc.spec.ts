import { expect, test } from '@playwright/test';
import {
  clearInbox,
  openLobby,
  readInbox,
  readPeers,
  readRole,
  readState,
  sendPacket,
  sendReliablePacket,
} from './hooks.js';

/**
 * Real WebRTC, real browsers, no server.
 *
 * This is the test that actually exercises the transport: two Chromium tabs on the same
 * origin signal each other over BroadcastChannel, negotiate a real RTCPeerConnection, open
 * both data channels, and move bytes. It catches the class of bug the unit tests cannot:
 * SDP the browser rejects, ICE ordering, channel configuration, and whether the transport
 * reports itself ready at the right moment.
 *
 * Why two tabs and not two machines: everything except ICE candidate gathering is the same,
 * and this runs in CI without a TURN server or a signalling service. Cross-network
 * behaviour needs a relay and stays a manual test (see docs/PROGRESS.md).
 */
test.describe('two-tab match', () => {
  test('negotiates over a real RTCPeerConnection and moves packets both ways', async ({ browser }) => {
    const context = await browser.newContext();
    const hostPage = await context.newPage();
    const guestPage = await context.newPage();

    await openLobby(hostPage);
    await openLobby(guestPage);

    // Create the room through the real button, then read the code a user would read.
    await hostPage.click('#create-room');
    await expect(hostPage.locator('#room-code')).not.toHaveText('----');
    const code = (await hostPage.locator('#room-code').textContent())?.trim() ?? '';
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    expect(await readRole(hostPage)).toBe('host');

    // Join through the real input, the way a person types a code: lower case, with spaces.
    await guestPage.fill('#join-code', ` ${code.toLowerCase()} `);
    await guestPage.click('#join-room');

    await expect.poll(() => readState(hostPage), { timeout: 30_000 }).toBe('ready');
    await expect.poll(() => readState(guestPage), { timeout: 30_000 }).toBe('ready');

    expect(await readPeers(hostPage)).toHaveLength(2);
    expect(await readPeers(guestPage)).toHaveLength(2);

    // Both directions, over both channel kinds.
    await clearInbox(hostPage);
    await clearInbox(guestPage);

    expect(await sendPacket(hostPage, [1, 2, 3])).toBe(true);
    expect(await sendPacket(guestPage, [9, 8])).toBe(true);
    expect(await sendReliablePacket(guestPage, [7, 7, 7])).toBe(true);

    await expect.poll(() => readInbox(guestPage).then((packets) => packets.length), { timeout: 15_000 })
      .toBeGreaterThan(0);

    expect(await readInbox(guestPage)).toContainEqual([1, 2, 3]);
    const atHost = await readInbox(hostPage);
    expect(atHost).toContainEqual([9, 8]);
    expect(atHost).toContainEqual([7, 7, 7]);

    await context.close();
  });

  test('a third tab is refused with a message instead of being silently paired', async ({ browser }) => {
    const context = await browser.newContext();
    const hostPage = await context.newPage();
    const guestPage = await context.newPage();
    const thirdPage = await context.newPage();

    await openLobby(hostPage);
    await openLobby(guestPage);
    await openLobby(thirdPage);

    await hostPage.click('#create-room');
    const code = (await hostPage.locator('#room-code').textContent())?.trim() ?? '';

    await guestPage.fill('#join-code', code);
    await guestPage.click('#join-room');
    await expect.poll(() => readState(hostPage), { timeout: 30_000 }).toBe('ready');

    await thirdPage.fill('#join-code', code);
    await thirdPage.click('#join-room');

    await expect.poll(() => readState(thirdPage)).toBe('error');
    await expect(thirdPage.locator('#lobby-error')).toContainText('full');

    await context.close();
  });

  test('a malformed code is refused without a round trip', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await openLobby(page);

    await page.fill('#join-code', 'IIII'); // I is not in the room alphabet
    await page.click('#join-room');

    await expect.poll(() => readState(page)).toBe('error');
    await expect(page.locator('#lobby-error')).toContainText('valid room code');

    await context.close();
  });
});
