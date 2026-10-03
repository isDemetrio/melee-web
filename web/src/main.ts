import { detectCapabilities, type CapabilityReport } from './platform/capabilities.js';
import { Shell } from './ui/app.js';
import { AudioBootstrap } from './ui/audio.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './ui/settings.js';
import { dropStaleServiceWorker } from './ui/sw-cleanup.js';
import type { AppContext } from './ui/context.js';

/**
 * Entry point.
 *
 * Boot order matters and is deliberate:
 *  1. settings load first, because the lobby needs the nickname and nothing may throw
 *     before there is a shell to show an error in;
 *  2. the shell renders immediately with a "checking…" state, so a slow or failing
 *     capability probe never leaves a blank page;
 *  3. capability detection runs after, and its result re-renders the boot screen.
 */
async function main(): Promise<void> {
  let settings: Settings = DEFAULT_SETTINGS;
  try {
    settings = loadSettings(window.localStorage);
  } catch {
    // localStorage can be unavailable (private mode, disabled storage). Defaults are fine.
  }

  const audio = new AudioBootstrap();
  let capabilities: CapabilityReport | null = null;
  let capabilitiesError: string | null = null;
  let shell: Shell;

  const context: AppContext = {
    get settings() {
      return settings;
    },
    updateSettings(patch: Partial<Settings>): void {
      settings = saveSettings(window.localStorage, { ...settings, ...patch });
      shell.log(`settings updated: ${Object.keys(patch).join(', ')}`);
    },
    get capabilities() {
      return capabilities;
    },
    get capabilitiesError() {
      return capabilitiesError;
    },
    audio,
    setAudioStatus: (text) => shell.setAudioStatus(text),
    navigate: (screen) => shell.navigate(screen),
    log: (line) => shell.log(line),
    userAgent: navigator.userAgent,
  };

  shell = new Shell(context);
  shell.log(`boot: ${navigator.userAgent}`);

  try {
    capabilities = await detectCapabilities();
    shell.log(
      `capabilities: webgpu=${capabilities.webgpu} isolated=${capabilities.crossOriginIsolated} threads=${capabilities.wasmThreads} exceptions=${capabilities.wasmExceptions} opfs=${capabilities.opfs}`,
    );
    if (!capabilities.usable) {
      shell.log(`this device is missing: ${capabilities.missing.join(', ')}`);
    }
  } catch (cause) {
    capabilitiesError = cause instanceof Error ? cause.message : 'unknown error';
    shell.log(`capability detection failed: ${capabilitiesError}`);
  }

  // Re-render the boot screen now that the report exists.
  shell.navigate('boot');

  if ('serviceWorker' in navigator && window.isSecureContext) {
    try {
      const dropped = await dropStaleServiceWorker({
        controller: navigator.serviceWorker.controller,
        guard: window.sessionStorage,
        getRegistrations: () => navigator.serviceWorker.getRegistrations(),
        cacheNames: () => caches.keys(),
        deleteCache: (name) => caches.delete(name),
        reload: () => window.location.reload(),
        log: (line) => shell.log(line),
      });
      // A reload is taking over: booting on would register the worker again on the way out.
      if (dropped) return;
      await navigator.serviceWorker.register('/sw.js');
      shell.log('service worker registered');
    } catch {
      shell.log('service worker registration failed (the shell still works)');
    }
  }
}

void main();
