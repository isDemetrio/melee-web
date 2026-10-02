import { simTimeStats } from './compare';

export type DecoderCostMode = 'off' | 'profile' | 'legacy';
export const DECODER_COST_HEADER = 'retrace,sim_ms,match_frame,record_ms,texture_ms,observer_ms,rest_ms,decode_ms,decode_rest_ms,non_decode_ms,record_calls,texture_calls,observer_calls,decode_calls';

/** Exclusive phases, with inclusive decode and its residuals explicitly labelled in the report. */
export function decoderCostReport(mode: DecoderCostMode, available: boolean, csv: string) {
  const errors: string[] = [];
  const summarize = (inMatch: boolean) => {
    try {
      const lines = csv.trim().split(/\r?\n/);
      if (lines.shift() !== DECODER_COST_HEADER) throw new Error('wrong decoder-cost header');
      const rows = lines.map(line => line.split(','));
      for (const row of rows) {
        if (row.length !== 14 || row.some(cell => !cell.trim() || !Number.isFinite(Number(cell)))) {
          throw new Error('invalid decoder-cost row');
        }
        // Signed residuals remain visible, but integer identifiers/counters cannot be negative.
        for (const index of [0, 2, 10, 11, 12, 13]) {
          if (!Number.isSafeInteger(Number(row[index])) || Number(row[index]) < 0) throw new Error('invalid decoder-cost counter');
        }
        const n = row.map(Number);
        if (Math.abs(n[1]! - n[3]! - n[4]! - n[5]! - n[6]!) > .00001 ||
            Math.abs(n[7]! - n[3]! - n[4]! - n[5]! - n[8]!) > .00001 ||
            Math.abs(n[1]! - n[7]! - n[9]!) > .00001) throw new Error('inconsistent decoder-cost partition');
      }
      const columns = DECODER_COST_HEADER.split(',');
      const phases = Object.fromEntries(columns.slice(3, 10).map((name, offset) => [name,
        simTimeStats('retrace,sim_ms,match_frame\n' + rows.map(row => `${row[0]},${row[offset + 3]},${row[2]}`).join('\n'), inMatch)]));
      const selected = rows.filter(row => !inMatch || Number(row[2]) > 0);
      const calls = Object.fromEntries(columns.slice(10).map((name, offset) => [name,
        selected.reduce((sum, row) => sum + Number(row[offset + 10]), 0)]));
      return { phases, calls, count: selected.length };
    } catch (error) { errors.push(`${inMatch ? 'in_match' : 'all'}: ${error}`); return null; }
  };
  const all = mode === 'profile' && available ? summarize(false) : null;
  const inMatch = mode === 'profile' && available ? summarize(true) : null;
  return { mode, available, csv, stats_all: all, stats_in_match: inMatch, errors,
    exclusive_phases: ['record_ms', 'texture_ms', 'observer_ms', 'rest_ms'],
    inclusive_phases: ['decode_ms'],
    notes: 'Instrumented wall time; timer/counter overhead is included. Observer is the per-draw hook only. rest_ms includes decoder cleanup, other observer hooks and simulation. Phase percentiles are not additive.' };
}
