import type { Metadata } from "next";
import { prisma } from "@wom/db";
import { requireUser } from "@/lib/auth";
import { FINAL_SESSION_STATUSES } from "@/lib/labels";
import { getCapacity } from "@/lib/capacity";
import { ScenariosView, type ScenarioCard } from "@/components/scenarios-view";
import { parseEnvironment } from "../scenario-json";

export const metadata: Metadata = { title: "Сценарии" };

export default async function ScenariosPage() {
  const user = await requireUser();
  const [all, solved, tried] = await Promise.all([
    prisma.scenario.findMany({
      where: { isPublished: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, slug: true, title: true, summary: true, type: true, difficulty: true, durationMin: true, tags: true, environmentJson: true },
    }),
    // what this person has already done: the best score of a solved scenario and a mark for any finished attempt
    prisma.trainingSession.groupBy({ by: ["scenarioId"], where: { userId: user.id, status: "FINISHED" }, _max: { score: true } }),
    prisma.trainingSession.groupBy({ by: ["scenarioId"], where: { userId: user.id, status: { in: [...FINAL_SESSION_STATUSES] } } }),
  ]);
  const bestScore = new Map(solved.map((r) => [r.scenarioId, r._max.score]));
  const triedIds = new Set(tried.map((r) => r.scenarioId));

  // only scenarios with a live environment are playable
  const scenarios = all.flatMap((s): ScenarioCard[] => {
    const env = parseEnvironment(s.environmentJson);
    if (!env) return [];
    return [{
      id: s.id,
      slug: s.slug,
      title: s.title,
      summary: s.summary,
      type: s.type,
      difficulty: s.difficulty,
      durationMin: s.durationMin,
      tags: s.tags,
      kind: env.kind,
      startupSec: env.startup?.expectedSec ?? null,
      progress: bestScore.has(s.id) ? { state: "solved", score: bestScore.get(s.id) ?? null } : triedIds.has(s.id) ? { state: "tried", score: null } : null,
    }];
  });

  const capacity = await getCapacity();

  return <ScenariosView scenarios={scenarios} capacity={capacity} />;
}
