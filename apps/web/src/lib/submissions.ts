// Author submissions: per-user quota, replacement of a superseded upload, slug ownership.
// Every submission keeps its zip (up to 5 MB) in PostgreSQL forever and the database is dumped daily, so unbounded
// uploads from one account would fill the disk.
import { prisma, SubmissionStatus, type Prisma } from "@wom/db";
import { TUTORIAL_SUFFIX } from "@wom/scenario";

/** waiting for the build, the regression or a moderator */
export const OPEN_STATUSES: SubmissionStatus[] = [SubmissionStatus.UPLOADED, SubmissionStatus.TESTING, SubmissionStatus.PASSED, SubmissionStatus.FAILED];
/** can still become a published scenario: another author's slug must not be taken from under them */
export const PENDING_STATUSES: SubmissionStatus[] = [SubmissionStatus.UPLOADED, SubmissionStatus.TESTING, SubmissionStatus.PASSED];
/** the author may replace these by uploading the same slug again (TESTING is being built right now) */
const REPLACEABLE_STATUSES: SubmissionStatus[] = [SubmissionStatus.UPLOADED, SubmissionStatus.LINT_FAILED, SubmissionStatus.PASSED, SubmissionStatus.FAILED];
const FINISHED_STATUSES: SubmissionStatus[] = [SubmissionStatus.APPROVED, SubmissionStatus.REJECTED, SubmissionStatus.LINT_FAILED];

export const MAX_OPEN_SUBMISSIONS = 3;
export const MAX_SUBMISSIONS = 20;

/** the regular scenario and its teaching copy are published together, so both slugs belong to the author */
export const scenarioSlugs = (slug: string) => [slug, slug + TUTORIAL_SUFFIX];

export type StoreResult = { ok: true; id: string } | { ok: false; status: number; error: string };

export async function storeSubmission(
  authorId: string,
  data: Omit<Prisma.ScenarioSubmissionUncheckedCreateInput, "authorId">,
): Promise<StoreResult> {
  const slug = data.slug;
  return prisma.$transaction(async (tx): Promise<StoreResult> => {
    // two uploads of one author at once must not both pass the count below
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"submission:" + authorId}))`;

    const owners = await tx.scenario.findMany({ where: { slug: { in: scenarioSlugs(slug) } }, select: { authorId: true } });
    if (owners.some((o) => o.authorId !== authorId)) return { ok: false, status: 409, error: `slug «${slug}» уже занят другим автором, выбери другой` };
    const rival = await tx.scenarioSubmission.findFirst({ where: { slug, authorId: { not: authorId }, status: { in: PENDING_STATUSES } }, select: { id: true } });
    if (rival) return { ok: false, status: 409, error: `slug «${slug}» уже занят заявкой другого автора, выбери другой` };

    const own = await tx.scenarioSubmission.findMany({ where: { authorId }, select: { id: true, slug: true, status: true }, orderBy: { createdAt: "asc" } });
    if (own.some((s) => s.slug === slug && s.status === SubmissionStatus.TESTING)) {
      return { ok: false, status: 409, error: "Эта заявка сейчас проверяется. Дождись результата и загрузи новую версию." };
    }
    const replaced = own.filter((s) => s.slug === slug && REPLACEABLE_STATUSES.includes(s.status));
    const kept = own.filter((s) => !replaced.includes(s));

    const asOpen = data.status === SubmissionStatus.UPLOADED || data.status === SubmissionStatus.PASSED;
    if (asOpen && kept.filter((s) => OPEN_STATUSES.includes(s.status)).length >= MAX_OPEN_SUBMISSIONS) {
      return { ok: false, status: 409, error: `Одновременно на рассмотрении может быть не больше ${MAX_OPEN_SUBMISSIONS} заявок. Дождись решения по предыдущим.` };
    }

    // the oldest finished submissions make room for the new one
    const surplus = kept.length + 1 - MAX_SUBMISSIONS;
    const evicted = surplus > 0 ? kept.filter((s) => FINISHED_STATUSES.includes(s.status)).slice(0, surplus) : [];
    const doomed = [...replaced, ...evicted].map((s) => s.id);
    if (doomed.length) await tx.scenarioSubmission.deleteMany({ where: { id: { in: doomed } } });

    const created = await tx.scenarioSubmission.create({ data: { ...data, authorId }, select: { id: true } });
    return { ok: true, id: created.id };
  });
}
