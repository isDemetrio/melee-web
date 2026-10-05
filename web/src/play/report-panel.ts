import { loadHeartbeat, type StoredHeartbeat } from '../spike/heartbeat.js';
import { h } from '../ui/context.js';
import { offeredModes } from './presentation.js';
import { PLAY_STORAGE_KEY, PlayReport } from './report.js';
import type { PlayPerf } from './session.js';

/** The report as a file, named like the spike's (`spike-result-<time>.json`). */
export function reportFile(value: unknown, prefix: string): File {
  return new File([JSON.stringify(value, null, 2)], `${prefix}-${new Date().toISOString().replaceAll(':', '-')}.json`,
    { type: 'application/json' });
}

/** Download a file now, without keeping a link around (the spike's saveJson). */
export function saveFile(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * The Game screen's report controls: the live line, the core split switch, and two ways to send the
 * report from a phone -- the share sheet where the browser can share files, a download otherwise.
 *
 * Until Play is pressed, the report is the record the previous session left in localStorage
 * (`melee-play-partial/1`, like the spike's `melee-spike-partial/1`): a tab that was killed mid-match
 * still has something to send. Pressing Play replaces it.
 */
export class ReportControls {
  readonly line = h('p', { class: 'status', id: 'perf-line' });
  readonly split = h('input', { id: 'game-split', type: 'checkbox' });
  /** How frames are handed to the page (presentation.ts); anything but `direct` is an experiment. */
  readonly presentation = h('select', { id: 'game-presentation', 'aria-label': 'Presentation' },
    offeredModes(location.search).map((mode) => h('option', { value: mode.name, text: mode.name })));
  readonly element: HTMLElement;
  private report: PlayReport | null = null;
  private previous: StoredHeartbeat | null = null;

  constructor(private readonly log: (line: string) => void) {
    const stored = loadHeartbeat(localStorage, PLAY_STORAGE_KEY);
    if (typeof stored === 'string') this.line.textContent = stored;
    else if (stored) {
      this.previous = stored;
      const perf = (stored.perf ?? {}) as { state?: string; line?: string; presentation?: { mode?: string } };
      // A session the page never saw end -- it closed, or the browser killed it -- is still `running`.
      const state = perf.state === 'running' ? 'did not end (the page closed or was killed)' : perf.state ?? 'unknown state';
      this.line.textContent = `previous session (${stored.startedAt}, presentation ${perf.presentation?.mode ?? 'unknown'}): ${state}; ` +
        `last heartbeat frame ${stored.last?.frame ?? 'none'}; ${perf.line ?? ''} — Save report sends it`;
    }
    const save = h('button', { id: 'game-report', text: 'Save report', onClick: () => {
      const file = this.file();
      if (!file) return;
      saveFile(file);
      this.log(`report saved: ${file.name}, ${file.size} bytes`);
    } });
    const share = h('button', { id: 'game-share', text: 'Share report', onClick: () => {
      const file = this.file();
      if (!file) return;
      // Built and shared in the same click: Safari shares only inside the user's gesture.
      if (typeof navigator.canShare !== 'function' || !navigator.canShare({ files: [file] })) {
        saveFile(file);
        this.log(`this browser cannot share files: report downloaded instead (${file.name})`);
        return;
      }
      navigator.share({ files: [file], title: file.name }).then(
        () => this.log(`report shared: ${file.name}`),
        (error: unknown) => {
          const text = error instanceof DOMException && error.name === 'AbortError'
            ? 'report sharing cancelled' : `report sharing failed: ${error}`;
          this.log(text);
          this.line.textContent = text;
        });
    } });
    this.element = h('div', {}, [
      h('div', { class: 'row' }, [save, share,
        h('label', { class: 'row' }, [this.split, 'core split (adds the core profiler\'s cost)']),
        h('label', { class: 'row' }, ['presentation', this.presentation])]),
      this.line,
    ]);
  }

  /** A new session's measurement; the previous session's record is no longer the report. */
  begin(): PlayPerf {
    this.report = new PlayReport(this.split.checked, performance.now());
    this.previous = null;
    return { report: this.report, split: this.split.checked, presentation: this.presentation.value, line: (text) => { this.line.textContent = text; } };
  }

  private file(): File | null {
    if (this.report) return reportFile(this.report.build(performance.now(), navigator.userAgent), 'play-report');
    if (this.previous) return reportFile({ schema: 'melee-play-partial/1', unfinished: this.previous }, 'play-unfinished');
    this.line.textContent = 'No session to report yet: press Play first.';
    return null;
  }
}
