import { simTimeStats } from './compare';

export type DecoderCostMode = 'off' | 'profile' | 'legacy';
export const DECODER_COST_HEADER = 'retrace,sim_ms,match_frame,record_ms,texture_ms,observer_ms,rest_ms,decode_ms,decode_rest_ms,non_decode_ms,record_calls,texture_calls,observer_calls,decode_calls,observer_game_ms,end_frame_ms,non_decode_rest_ms,allocate_joint_calls,load_joint_calls,release_joint_calls,display_joint_calls,rigid_matrix_calls,other_matrix_calls,envelope_matrix_calls,end_frame_calls,watched_ram_block_writes,watched_ram_blocks';

/** Exclusive phases, with inclusive decode and its residuals explicitly labelled in the report. */
export function decoderCostReport(mode: DecoderCostMode, available: boolean, csv: string) {
  const errors: string[] = [];
  const summarize = (inMatch: boolean) => {
    try {
      const lines = csv.trim().split(/\r?\n/);
      if (lines.shift() !== DECODER_COST_HEADER) throw new Error('wrong decoder-cost header');
      const rows = lines.map(line => line.split(','));
      for (const row of rows) {
        if (row.length !== 27 || row.some(cell => !cell.trim() || !Number.isFinite(Number(cell)))) {
          throw new Error('invalid decoder-cost row');
        }
        // Signed residuals remain visible, but integer identifiers/counters cannot be negative.
        for (const index of [0, 2, 10, 11, 12, 13, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]) {
          if (!Number.isSafeInteger(Number(row[index])) || Number(row[index]) < 0) throw new Error('invalid decoder-cost counter');
        }
        const n = row.map(Number);
        if (n[26]! > 384) throw new Error('invalid watched RAM block count');
        if (Math.abs(n[1]! - n[3]! - n[4]! - n[5]! - n[6]! - n[14]! - n[15]!) > .00001 ||
            Math.abs(n[7]! - n[3]! - n[4]! - n[5]! - n[8]! - n[15]!) > .00001 ||
            Math.abs(n[1]! - n[7]! - n[9]!) > .00001 ||
            Math.abs(n[9]! - n[14]! - n[16]!) > .00001 ||
            Math.abs(n[6]! - n[8]! - n[16]!) > .00001) throw new Error('inconsistent decoder-cost partition');
      }
      const columns = DECODER_COST_HEADER.split(',');
      const phases = Object.fromEntries([3, 4, 5, 6, 7, 8, 9, 14, 15, 16].map(index => [columns[index]!,
        simTimeStats('retrace,sim_ms,match_frame\n' + rows.map(row => `${row[0]},${row[index]},${row[2]}`).join('\n'), inMatch)]));
      const selected = rows.filter(row => !inMatch || Number(row[2]) > 0);
      const calls = Object.fromEntries([10, 11, 12, 13, 17, 18, 19, 20, 21, 22, 23, 24, 25].map(index => [columns[index]!,
        selected.reduce((sum, row) => sum + Number(row[index]), 0)]));
      const blocks = selected.map(row => Number(row[26]));
      return { phases, calls, count: selected.length,
        watched_ram_blocks: { min: Math.min(...blocks), max: Math.max(...blocks), last: blocks.at(-1)! } };
    } catch (error) { errors.push(`${inMatch ? 'in_match' : 'all'}: ${error}`); return null; }
  };
  const all = mode === 'profile' && available ? summarize(false) : null;
  const inMatch = mode === 'profile' && available ? summarize(true) : null;
  return { mode, available, csv, stats_all: all, stats_in_match: inMatch, errors,
    exclusive_phases: ['record_ms', 'texture_ms', 'observer_ms', 'observer_game_ms', 'end_frame_ms', 'decode_rest_ms', 'non_decode_rest_ms'],
    inclusive_phases: ['decode_ms', 'non_decode_ms', 'rest_ms'],
    notes: 'Instrumented wall time; timer/counter overhead is included. observer_ms is per-draw; observer_game_ms times hook entry/exit only, excluding guest execution. end_frame_ms covers XFB completion including submission/recycling and cleanup, inside decode_ms. rest_ms = decode_rest_ms + non_decode_rest_ms. Hook counts count entries. watched_ram_block_writes counts watched block hits (a spanning write can count more than once), not bytes or write time; watched_ram_blocks is a per-retrace gauge. Disabled profiling reads no additional clocks or counters; flag checks remain. Phase percentiles are not additive.' };
}
