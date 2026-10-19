type Row = { kind: " " | "+" | "-"; text: string };

const MAX_CELLS = 4_000_000;
const CONTEXT_LINES = 3;

/** line diff via LCS; null when the changed region is too large to compare line by line */
function diffLines(a: string[], b: string[]): Row[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_CELLS) return null;
  // n * m is capped, so the shorter side (and with it every LCS length) fits into 16 bits
  const w = m + 1;
  const lcs = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[start + i] === b[start + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const rows: Row[] = a.slice(0, start).map((text) => ({ kind: " ", text }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      rows.push({ kind: " ", text: a[start + i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      rows.push({ kind: "-", text: a[start + i++] });
    } else {
      rows.push({ kind: "+", text: b[start + j++] });
    }
  }
  while (i < n) rows.push({ kind: "-", text: a[start + i++] });
  while (j < m) rows.push({ kind: "+", text: b[start + j++] });
  for (let k = endA; k < a.length; k++) rows.push({ kind: " ", text: a[k] });
  return rows;
}

const COLOR: Record<Row["kind"], string> = { " ": "var(--muted)", "+": "var(--ok)", "-": "var(--bad)" };

/** changed lines of `after` against `before` with a few lines of context around each change */
export function LineDiff({ before, after }: { before: string; after: string }) {
  const lines = (s: string) => (s === "" ? [] : s.split(/\r?\n/));
  const rows = diffLines(lines(before), lines(after));
  if (!rows) {
    return (
      <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
        Изменений слишком много для построчного сравнения: сравни по архиву.
      </p>
    );
  }
  if (rows.every((r) => r.kind === " ")) {
    return (
      <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
        Отличаются только переводы строк.
      </p>
    );
  }
  const keep = rows.map(() => false);
  rows.forEach((r, k) => {
    if (r.kind === " ") return;
    for (let c = Math.max(0, k - CONTEXT_LINES); c <= Math.min(rows.length - 1, k + CONTEXT_LINES); c++) keep[c] = true;
  });
  return (
    <pre className="mt-1 max-h-96 overflow-auto rounded-md bg-inset p-2 text-xs">
      {rows.map((r, k) => {
        if (!keep[k]) {
          return k === 0 || keep[k - 1] ? (
            <span key={k} className="block" style={{ color: "var(--muted)" }}>
              ⋯
            </span>
          ) : null;
        }
        return (
          <span key={k} className="block" style={{ color: COLOR[r.kind] }}>
            {r.kind} {r.text}
          </span>
        );
      })}
    </pre>
  );
}
