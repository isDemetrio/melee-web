import type { Page } from '@playwright/test';

/**
 * Typed access to the test hooks the app installs when it is opened with
 * `?signal=broadcast` (see web/src/ui/test-hooks.ts). Keeping the shape in one place means
 * the specs read as intent instead of as `page.evaluate` plumbing.
 */
export interface HookHandle {
  state(): string;
  code(): string | null;
  role(): string;
  peers(): readonly string[];
  createRoom(): Promise<string>;
  joinRoom(code: string): Promise<string | null>;
  send(bytes: number[]): boolean;
  sendReliable(bytes: number[]): boolean;
  received(): number[][];
  clear(): void;
}

declare global {
  interface Window {
    __meleeLobby: HookHandle;
  }
}

export const readState = (page: Page): Promise<string> =>
  page.evaluate(() => window.__meleeLobby.state());

export const readRole = (page: Page): Promise<string> =>
  page.evaluate(() => window.__meleeLobby.role());

export const readPeers = (page: Page): Promise<readonly string[]> =>
  page.evaluate(() => window.__meleeLobby.peers());

export const sendPacket = (page: Page, bytes: number[]): Promise<boolean> =>
  page.evaluate((payload: number[]) => window.__meleeLobby.send(payload), bytes);

export const sendReliablePacket = (page: Page, bytes: number[]): Promise<boolean> =>
  page.evaluate((payload: number[]) => window.__meleeLobby.sendReliable(payload), bytes);

export const readInbox = (page: Page): Promise<number[][]> =>
  page.evaluate(() => window.__meleeLobby.received());

export const clearInbox = (page: Page): Promise<void> =>
  page.evaluate(() => window.__meleeLobby.clear());

export const openLobby = async (page: Page): Promise<void> => {
  await page.goto('/?signal=broadcast');
  await page.click('button:has-text("Lobby")');
  await page.waitForFunction(() => '__meleeLobby' in window);
};
