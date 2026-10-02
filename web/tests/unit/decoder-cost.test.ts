import { describe, expect, it } from 'vitest';
import { DECODER_COST_HEADER, decoderCostReport } from '../../src/spike/decoder-cost';
const csv = DECODER_COST_HEADER + '\n1,10,0,2,1,1,6,8,4,2,100,80,80,500\n2,20,1,4,2,2,12,16,8,4,200,160,160,1000\n';
describe('decoder cost report', () => {
  it('keeps exclusive phases, inclusive decode, match filtering and invocation counts distinct', () => {
    const report = decoderCostReport('profile', true, csv);
    expect(report.errors).toEqual([]);
    expect(report.stats_all?.phases.record_ms?.mean_ms).toBe(3);
    expect(report.stats_in_match?.phases.record_ms?.mean_ms).toBe(4);
    expect(report.stats_in_match?.phases.decode_ms?.mean_ms).toBe(16);
    expect(report.stats_all?.calls.record_calls).toBe(300);
    expect(report.stats_in_match?.calls.record_calls).toBe(200);
    expect(report.csv).toBe(csv);
  });
  it('never presents disabled or old-core profiling as measured zeros', () => {
    expect(decoderCostReport('off', false, '').stats_all).toBeNull();
    expect(decoderCostReport('legacy', true, '').stats_all).toBeNull();
  });
  it('preserves raw evidence and surfaces malformed or non-additive data', () => {
    for (const broken of [csv.replace(',2,1,1,6,', ',3,1,1,6,'), csv.replace(',100,80', ',NaN,80'), '']) {
      const report = decoderCostReport('profile', true, broken);
      expect(report.csv).toBe(broken);
      expect(report.stats_all).toBeNull();
      expect(report.errors.length).toBeGreaterThan(0);
    }
  });
  it('preserves signed residuals and reports a run without in-match samples', () => {
    const report = decoderCostReport('profile', true, DECODER_COST_HEADER + '\n1,1,0,1,1,1,-2,4,1,-3,1,1,1,1\n');
    expect(report.stats_all?.phases.rest_ms?.mean_ms).toBe(-2);
    expect(report.stats_in_match).toBeNull();
    expect(report.errors[0]).toContain('in_match');
  });
});
