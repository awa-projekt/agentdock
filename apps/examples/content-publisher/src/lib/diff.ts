/** Minimal line-level diff (LCS) for the "compare with the AI's draft" view. */
export type DiffRow = { type: 'same' | 'add' | 'remove'; text: string };

export const diffLines = (before: string, after: string): DiffRow[] => {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  const n = a.length;
  const m = b.length;

  // lcs[i][j] = length of LCS of a[i:] and b[j:]. Indices below are always in
  // range by construction, so the non-null assertions are safe.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = lcs[i]!;
    const next = lcs[i + 1]!;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ type: 'remove', text: a[i]! });
      i += 1;
    } else {
      rows.push({ type: 'add', text: b[j]! });
      j += 1;
    }
  }
  while (i < n) rows.push({ type: 'remove', text: a[i++]! });
  while (j < m) rows.push({ type: 'add', text: b[j++]! });
  return rows;
};

export const hasChanges = (before: string, after: string): boolean =>
  before.replace(/\r\n/g, '\n').trim() !== after.replace(/\r\n/g, '\n').trim();
