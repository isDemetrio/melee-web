import { describe, expect, it } from 'vitest';
import { compareTraces, nearestRank, simTimeStats, TRACE_HEADER } from '../../src/spike/compare';
const header = TRACE_HEADER.join(',') + '\n';
const trace = header + '1,a,b,c,d\n2,e,f,g,h\n';
describe('checkpoint comparison', () => {
  it('compares identical traces and skips blank lines', () => {
    expect(compareTraces(trace, trace + '\n')).toMatchObject({ identical: true, leftRows: 2, differences: 0, first: null });
  });
  it('reports the first changed cell with header-counted row', () => {
    expect(compareTraces(trace, trace.replace('f,g', 'x,y'))).toMatchObject({ differences: 2,
      first: { retrace: '2', row: 3, column: 'ram', left: 'f', right: 'x' } });
  });
  it('counts each extra row without inventing a differing cell', () => {
    expect(compareTraces(trace, header)).toMatchObject({ identical: false, differences: 2, first: null });
    expect(compareTraces(header, trace).differences).toBe(2);
  });
  it('rejects wrong headers and short rows', () => {
    expect(() => compareTraces('bad\n', trace)).toThrow();
    expect(() => compareTraces(header + '1,a\n', trace)).toThrow();
  });
});
describe('simulation timing', () => {
  it('uses nearest-rank percentiles and numeric sorting', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1).reverse();
    expect(nearestRank(values, .95)).toBe(95);
    expect(nearestRank(values, .99)).toBe(99);
    expect(nearestRank([10, 20, 30], .95)).toBe(30);
    expect(nearestRank([42], .99)).toBe(42);
  });
  it('filters positive match frames and reports the first slowest filtered index', () => {
    const csv = 'retrace,sim_ms,match_frame\n1,100,0\n2,99,0\n3,2,1\n4,4,2\n5,4,3\n';
    expect(simTimeStats(csv, true)).toMatchObject({ count: 3, mean_ms: 10 / 3, max_ms: 4, slowest_index: 1, rows: 'in-match' });
    expect(simTimeStats(csv, false).count).toBe(5);
  });
  it('rejects missing rows, wrong headers and invalid numbers', () => {
    expect(() => simTimeStats('retrace,sim_ms,match_frame\n1,2,0', true)).toThrow('no in-match rows');
    expect(() => simTimeStats('', false)).toThrow();
    expect(() => simTimeStats('retrace,sim_ms,match_frame\n1,no,1', false)).toThrow();
  });
});
