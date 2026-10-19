// Account hygiene (owner decision 2026-09-30): accounts with no activity for INACTIVE_ACCOUNT_DAYS (7) are disabled.
// Activity = any authenticated request (web bumps lastLoginAt at most hourly), not only a password login.
// Disabled users cannot log in and their browser sessions stop working at once (web checks disabledAt on every request).
import type { PrismaClient } from "@wom/db";
import { logger } from "./logger";

export class AccountJanitor {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private prisma: PrismaClient,
    private opts: { inactiveDays: number; intervalMs?: number; now?: () => Date },
  ) {}

  start() {
    if (this.opts.inactiveDays <= 0) return;
    void this.runSafe();
    this.timer = setInterval(() => void this.runSafe(), this.opts.intervalMs ?? 6 * 60 * 60 * 1000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async runSafe() {
    try {
      const n = await this.run();
      if (n) logger.info({ disabled: n, inactiveDays: this.opts.inactiveDays }, "inactive accounts disabled");
    } catch (err) {
      logger.error({ err }, "account janitor failed");
    }
  }

  /** disables non-admin accounts whose last login (or creation, if they never logged in) is older than the threshold */
  async run(): Promise<number> {
    const now = this.opts.now?.() ?? new Date();
    const cutoff = new Date(now.getTime() - this.opts.inactiveDays * 24 * 60 * 60 * 1000);
    const stale = await this.prisma.user.findMany({
      where: {
        disabledAt: null,
        role: { not: "admin" },
        OR: [{ lastLoginAt: { lt: cutoff } }, { lastLoginAt: null, createdAt: { lt: cutoff } }],
      },
      select: { id: true },
    });
    if (!stale.length) return 0;
    const ids = stale.map((u) => u.id);
    await this.prisma.$transaction([
      this.prisma.user.updateMany({ where: { id: { in: ids } }, data: { disabledAt: now } }),
      this.prisma.session.deleteMany({ where: { userId: { in: ids } } }),
    ]);
    return ids.length;
  }
}
