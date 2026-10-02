import { describe, expect, it } from 'vitest';
import { DECODER_COST_HEADER, decoderCostReport } from '../../src/spike/decoder-cost';
const csv = DECODER_COST_HEADER + '\n1,10,0,2,1,1,4.5,8,3,2,100,80,80,500,0.5,1,1.5,1,2,3,4,5,6,7,1,80,10\n2,20,1,4,2,2,9,16,6,4,200,160,160,1000,1,2,3,2,4,6,8,10,12,14,2,160,12\n';
describe('decoder cost report', () => {
  it('keeps exclusive phases, inclusive decode, match filtering and invocation counts distinct', () => {
    const report = decoderCostReport('profile', true, csv);
    expect(report.errors).toEqual([]);
    expect(report.stats_all?.phases.record_ms?.mean_ms).toBe(3);
    expect(report.stats_in_match?.phases.record_ms?.mean_ms).toBe(4);
    expect(report.stats_in_match?.phases.decode_ms?.mean_ms).toBe(16);
    expect(report.stats_in_match?.phases.observer_game_ms?.mean_ms).toBe(1);
    expect(report.stats_in_match?.phases.end_frame_ms?.mean_ms).toBe(2);
    expect(report.stats_in_match?.phases.non_decode_rest_ms?.mean_ms).toBe(3);
    expect(report.stats_all?.calls.record_calls).toBe(300);
    expect(report.stats_in_match?.calls.record_calls).toBe(200);
    expect(report.stats_all?.calls.display_joint_calls).toBe(12);
    expect(report.stats_in_match?.calls.envelope_matrix_calls).toBe(14);
    expect(report.stats_all?.calls.watched_ram_block_writes).toBe(240);
    expect(report.stats_all?.watched_ram_blocks).toEqual({ min: 10, max: 12, last: 12 });
    const phases = report.stats_in_match!.phases;
    expect(report.exclusive_phases.reduce((sum, key) => sum + phases[key]!.mean_ms, 0)).toBe(20);
    expect(report.csv).toBe(csv);
  });
  it('never presents disabled or old-core profiling as measured zeros', () => {
    expect(decoderCostReport('off', false, '').stats_all).toBeNull();
    expect(decoderCostReport('legacy', true, '').stats_all).toBeNull();
    expect(decoderCostReport('profile', true, 'retrace,sim_ms\n1,10').stats_all).toBeNull();
  });
  it('rejects corruption in every phase, including each new partition', () => {
    for (const index of [1, 3, 4, 5, 6, 7, 8, 9, 14, 15, 16]) {
      const lines = csv.trim().split('\n');
      const row = lines[1]!.split(',');
      row[index] = String(Number(row[index]) + 1);
      lines[1] = row.join(',');
      const broken = lines.join('\n');
      const report = decoderCostReport('profile', true, broken);
      expect(report.csv).toBe(broken);
      expect(report.stats_all).toBeNull();
      expect(report.stats_in_match).toBeNull();
      expect(report.errors.join()).toContain('inconsistent decoder-cost partition');
    }
  });
  it('rejects malformed rows and negative or fractional counters', () => {
    for (const broken of [csv.replace(',100,80', ',NaN,80'), csv.replace(',80,10\n', ',-1,10\n'),
      csv.replace(',80,10\n', ',80,1.5\n'), csv.replace(',80,10\n', ',80\n'), '']) {
      const report = decoderCostReport('profile', true, broken);
      expect(report.stats_all).toBeNull();
      expect(report.errors.length).toBeGreaterThan(0);
    }
  });
  it('preserves signed residuals and reports a run without in-match samples', () => {
    const report = decoderCostReport('profile', true, DECODER_COST_HEADER + '\n1,1,0,1,1,1,-4,4,0,-3,1,1,1,1,1,1,-4,1,1,1,1,1,1,1,1,1,1\n');
    expect(report.stats_all?.phases.rest_ms?.mean_ms).toBe(-4);
    expect(report.stats_all?.phases.non_decode_rest_ms?.mean_ms).toBe(-4);
    expect(report.stats_in_match).toBeNull();
    expect(report.errors[0]).toContain('in_match');
  });
});
