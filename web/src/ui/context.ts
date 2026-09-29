import type { ScreenName } from '../types.js';
import type { CapabilityReport } from '../platform/capabilities.js';
import type { AudioBootstrap } from './audio.js';
import type { Settings } from './settings.js';

/**
 * What a screen is allowed to touch. Kept in its own module so screens and the shell can
 * import it without a cycle.
 */
export interface AppContext {
  readonly settings: Settings;
  updateSettings(patch: Partial<Settings>): void;
  readonly capabilities: CapabilityReport | null;
  readonly capabilitiesError: string | null;
  readonly audio: AudioBootstrap;
  navigate(screen: ScreenName): void;
  /** Append a line to the on-screen diagnostic log. */
  log(line: string): void;
  readonly userAgent: string;
}

/** Minimal element builder. No framework, no virtual DOM, no build step. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string | number | boolean | ((event: Event) => void)>> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (typeof value === 'boolean') {
      if (value) node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}
