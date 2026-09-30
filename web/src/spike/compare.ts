export const TRACE_HEADER = ['retrace', 'cpu', 'ram', 'aram', 'events'];

// Runtime CSVs contain no quoted fields; reject malformed rows instead of guessing.
function traceRows(csv: string): string[][] {
  const lines = csv.split(/\r?\n/);
  if (lines.shift() !== TRACE_HEADER.join(',')) throw new Error('wrong trace header');
  return lines.filter(line => line !== '').map(line => {
    const cells = line.split(',');
    if (cells.length !== 5) throw new Error('trace row must have 5 cells');
    return cells;
  });
}

export function compareTraces(left: string, right: string) {
  const a = traceRows(left), b = traceRows(right);
  let differences = Math.abs(a.length - b.length);
  let first: { retrace: string; row: number; column: string; left: string; right: string } | null = null;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    for (let c = 0; c < TRACE_HEADER.length; c++) {
      if (a[i]![c] !== b[i]![c]) {
        first ??= { retrace: a[i]![0]!, row: i + 2, column: TRACE_HEADER[c]!, left: a[i]![c]!, right: b[i]![c]! };
        differences++;
      }
    }
  }
  return { identical: differences === 0, leftRows: a.length, rightRows: b.length, differences, first };
}

export function nearestRank(values: number[], fraction: number): number {
  if (!values.length) throw new Error('no rows');
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(fraction * values.length) - 1)]!;
}

export function simTimeStats(csv: string, inMatch: boolean) {
  const lines = csv.split(/\r?\n/).filter(line => line.trim());
  if (lines.shift()?.trim() !== 'retrace,sim_ms,match_frame') throw new Error('wrong sim-times header');
  const values: number[] = [];
  for (const line of lines) {
    const cells = line.split(',').map(cell => cell.trim());
    if (cells.length !== 3 || !/^[+-]?\d+$/.test(cells[2]!)) throw new Error('invalid sim-times row');
    if (inMatch && Number(cells[2]) <= 0) continue;
    const value = Number(cells[1]);
    if (!cells[1] || !Number.isFinite(value)) throw new Error('invalid duration');
    values.push(value);
  }
  if (!values.length) throw new Error(inMatch ? 'no in-match rows' : 'no durations');
  const max = Math.max(...values);
  return { count: values.length, mean_ms: values.reduce((a, b) => a + b, 0) / values.length,
    p95_ms: nearestRank(values, .95), p99_ms: nearestRank(values, .99), max_ms: max,
    slowest_index: values.indexOf(max), percentile: 'nearest-rank', unit: 'ms', rows: inMatch ? 'in-match' : 'all' };
}
