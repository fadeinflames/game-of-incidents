import { SUBMISSION_STATUS } from "@/lib/labels";

export { SUBMISSION_STATUS };

type LintIssue = { level: "error" | "warning"; rule: string; message: string };
type TestReport = { ok: boolean; steps: { name: string; ok: boolean; detail: string }[]; timings?: { createMs: number; breakMs: number }; build?: string; error?: string };

export function SubmissionReport({ lint, test, note }: { lint: unknown; test: unknown; note: string | null }) {
  const issues = (Array.isArray(lint) ? lint : []) as LintIssue[];
  const report = (test && typeof test === "object" ? test : null) as TestReport | null;
  return (
    <div className="mt-3 flex flex-col gap-2">
      {note && (
        <p className="rounded-md border border-[var(--border)] p-2">
          <span style={{ color: "var(--muted)" }}>Комментарий модератора: </span>
          {note}
        </p>
      )}
      {issues.length > 0 && (
        <ul className="flex flex-col gap-1">
          {issues.map((i, k) => (
            <li key={k} className="flex gap-2">
              <span style={{ color: i.level === "error" ? "var(--bad)" : "var(--accent)" }}>{i.level === "error" ? "✘" : "!"}</span>
              <span>
                <code>{i.rule}</code> {i.message}
              </span>
            </li>
          ))}
        </ul>
      )}
      {issues.length === 0 && !report && (
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          Формат в порядке. Сборка и регресс запускаются модератором.
        </p>
      )}
      {report && (
        <div>
          <p className="mb-1 font-semibold" style={{ color: report.ok ? "var(--ok)" : "var(--bad)" }}>
            {report.ok ? "Регресс пройден" : "Регресс не пройден"}
            {report.timings ? ` · создание ${report.timings.createMs} мс, поломка ${report.timings.breakMs} мс` : ""}
          </p>
          {report.error && <p style={{ color: "var(--bad)" }}>{report.error}</p>}
          <ul className="flex flex-col gap-1">
            {(report.steps ?? []).map((s, k) => (
              <li key={k} className="flex gap-2">
                <span style={{ color: s.ok ? "var(--ok)" : "var(--bad)" }}>{s.ok ? "✔" : "✘"}</span>
                <span>
                  {s.name}
                  {s.detail ? <span style={{ color: "var(--muted)" }}> · {s.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          {report.build && (
            <details className="spoiler mt-2">
              <summary className="text-xs" style={{ color: "var(--muted)" }}>
                лог сборки
              </summary>
              <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-inset p-2 text-xs">{report.build}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
