import { Badge } from "./badge";

export type Progress = { state: "solved"; score: number | null } | { state: "tried"; score: null };

const balls = (n: number) => {
  const last = n % 10;
  const tens = n % 100;
  return last === 1 && tens !== 11 ? "балл" : last >= 2 && last <= 4 && (tens < 12 || tens > 14) ? "балла" : "баллов";
};

/** the person's own result on a scenario: solved (with the best score) or at least tried */
export function ProgressBadge({ progress }: { progress: Progress | null }) {
  if (!progress) return null;
  if (progress.state === "solved") {
    return (
      <Badge tone="ok" testId="progress-solved">
        ✔ решено{progress.score != null ? ` · ${progress.score} ${balls(progress.score)}` : ""}
      </Badge>
    );
  }
  return (
    <Badge testId="progress-tried" title="Ты уже запускал этот сценарий, но не решил его">
      попытка была
    </Badge>
  );
}
