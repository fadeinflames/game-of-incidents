// End-to-end checks, from the cheap ones that need nothing to the full game flow.
//
// What runs depends on the environment, so the same file serves a dev stack and the production smoke test:
//   - public pages (404, icons, WebSocket 401, phone width) need nothing but E2E_BASE_URL;
//   - the game flow needs an ordinary account (E2E_USER / E2E_PASSWORD);
//   - moderation, killing a session and the disabled-account check need an admin (E2E_ADMIN / E2E_ADMIN_PASSWORD);
//   - one Kubernetes scenario runs only with E2E_KIND=1 (it takes a kind slot).
// On localhost the seeded "demo" account (an admin) is the default for both; production has no such account, so there
// the credentials must come from the environment and the tests without them are skipped.
// E2E_START_LIMIT_SEC (default 30) is the startup budget of the container stand; E2E_ORCHESTRATOR_URL points the
// WebSocket and internal-API checks at the orchestrator directly (default: 127.0.0.1:3080 locally, the public origin otherwise).
//
// An account that is idle for 7 days is disabled by the platform: a production e2e account has to be used at least weekly.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(BASE);
const USER = process.env.E2E_USER ?? (LOCAL ? "demo" : "");
const PASSWORD = process.env.E2E_PASSWORD ?? (LOCAL ? "demo1234" : "");
const ADMIN = process.env.E2E_ADMIN ?? (LOCAL ? "demo" : "");
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? (LOCAL ? "demo1234" : "");
const START_LIMIT_SEC = Number(process.env.E2E_START_LIMIT_SEC ?? 30);
const KIND = process.env.E2E_KIND === "1";
const ORCH = process.env.E2E_ORCHESTRATOR_URL ?? (LOCAL ? "http://127.0.0.1:3080" : BASE);

const ACTIVE_ROW = /идёт|поднимается|в очереди/;

async function loginAs(page: Page, name: string, password: string) {
  await page.goto("/login");
  await expect(page.locator("form[data-hydrated='true']")).toBeVisible(); // wait for React before submitting
  await page.getByLabel("Имя пользователя").fill(name);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page).toHaveURL(/\/scenarios/);
}

async function newPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE });
  return { context, page: await context.newPage() };
}

async function typeInTerminal(page: Page, text: string) {
  // xterm.js reads keyboard input through a hidden textarea; focus it directly (the canvas host is never "stable" for Playwright)
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(text, { delay: 5 });
  await page.keyboard.press("Enter");
}

/** stop a leftover active session of the signed-in user (one active stand per user), e.g. from a failed previous run */
async function stopActive(page: Page) {
  await page.goto("/history");
  const running = page.getByRole("row").filter({ hasText: ACTIVE_ROW }).first();
  if (await running.count()) {
    await running.getByRole("link").first().click();
    page.once("dialog", (d) => d.accept());
    await page.getByTestId("stop").click();
    await expect(page.getByTestId("session-status")).toHaveText(/остановлена/);
  }
}

async function register(page: Page, name: string) {
  await page.goto("/register");
  await expect(page.locator("form[data-hydrated='true']")).toBeVisible();
  await page.getByLabel("Имя пользователя").fill(name);
  await page.getByLabel("Пароль").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Создать аккаунт" }).click();
  await expect(page).toHaveURL(/\/scenarios/);
}

const uniqueName = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

function zipFolder(dir: string, prefix = ""): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, r);
      else files[prefix + r] = new Uint8Array(readFileSync(full));
    }
  };
  walk(dir, "");
  return files;
}

/** a copy of the nginx scenario under a new slug, so it does not collide with the seeded one */
function scenarioZip(slug: string): Buffer {
  const src = path.resolve(__dirname, "../../../scenarios/nginx-502-upstream");
  const files = zipFolder(src, `${slug}/`);
  const yaml = new TextDecoder()
    .decode(files[`${slug}/scenario.yaml`])
    .replace(/slug: nginx-502-upstream/, `slug: ${slug}`)
    .replace(/wom-scenario\/nginx-502-upstream:dev/g, `wom-scenario/${slug}:dev`);
  files[`${slug}/scenario.yaml`] = new TextEncoder().encode(yaml);
  return Buffer.from(zipSync(files));
}

async function upload(page: Page, slug: string) {
  await page.goto("/author");
  await page.setInputFiles("#archive", { name: `${slug}.zip`, mimeType: "application/zip", buffer: scenarioZip(slug) });
  await page.getByTestId("submission-submit").click();
  await expect(page.getByRole("status").filter({ hasText: "формат в порядке" })).toBeVisible();
  await expect(page.getByTestId(`submission-${slug}`).first().getByTestId("submission-status")).toHaveText("ждёт проверки");
}

async function openSubmission(admin: Page, slug: string) {
  await admin.goto("/admin/submissions");
  await admin.getByTestId(`admin-submission-${slug}`).first().getByTestId("submission-open").click();
  return admin.getByTestId("submission-detail");
}

// ---- what the e2e itself leaves behind, cleaned up in afterAll through the admin pages ----
const createdUsers: string[] = [];
const publishedSlugs: string[] = [];

test.afterAll(async ({ browser }) => {
  if (!ADMIN || (createdUsers.length === 0 && publishedSlugs.length === 0)) return;
  const { context, page } = await newPage(browser);
  try {
    await loginAs(page, ADMIN, ADMIN_PASSWORD);
    // there is no delete for accounts: the test accounts are disabled
    for (const name of createdUsers) {
      await page.goto(`/admin/users?q=${encodeURIComponent(name)}`);
      const disable = page.getByTestId(`user-${name}`).getByTestId("user-disable");
      if (await disable.count()) {
        page.once("dialog", (d) => d.accept());
        await disable.click();
        await expect(page.getByTestId(`user-${name}`)).toContainText("отключён");
      }
    }
    // the published copies leave the catalogue
    for (const slug of publishedSlugs) {
      await page.goto("/admin/scenarios");
      const hide = page.getByTestId(`admin-scenario-${slug}`).getByTestId("scenario-unpublish");
      if (await hide.count()) {
        page.once("dialog", (d) => d.accept());
        await hide.click();
        await expect(page.getByTestId(`admin-scenario-${slug}`)).toContainText("скрыт");
      }
    }
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------- public: no account needed

test.describe("public", () => {
  test("an unknown page gets a Russian 404 with a way back", async ({ page }) => {
    const res = await page.goto("/no-such-page");
    expect(res?.status()).toBe(404);
    await expect(page.getByTestId("not-found")).toContainText("Такой страницы нет");
    await expect(page.getByRole("link", { name: "К сценариям" })).toBeVisible();
  });

  test("the icon and the link preview image are served", async ({ request }) => {
    const icon = await request.get("/icon.svg");
    expect(icon.status()).toBe(200);
    const og = await request.get("/opengraph-image");
    expect(og.status()).toBe(200);
    expect(og.headers()["content-type"]).toContain("image/png");
  });

  test("terminal WebSocket rejects a bad token", async ({ request }) => {
    // on production this goes through Caddy (/ws/term/* -> orchestrator), the same way the browser connects
    const res = await request.get(`${ORCH}/ws/term/anything?token=wrong`, {
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(401);
  });

  test("internal API is closed without the shared secret", async ({ request }) => {
    test.skip(!process.env.E2E_ORCHESTRATOR_URL && !LOCAL, "the orchestrator is not published on this host");
    const res = await request.post(`${ORCH}/sessions`, { data: { userId: "x", scenarioId: "y" } });
    expect(res.status()).toBe(401);
  });

  test("the public pages fit a phone screen", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    for (const url of ["/", "/login", "/register"]) {
      await page.goto(url);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `horizontal scroll on ${url}`).toBeLessThanOrEqual(0);
    }
  });

  test("anyone can register with a login and a password only", async ({ page }) => {
    const name = uniqueName("e2e");
    createdUsers.push(name);
    await register(page, name);
    await expect(page.getByText(name)).toBeVisible();
  });
});

// ---------------------------------------------------------------- an ordinary player

test.describe("player", () => {
  test.skip(!USER, "set E2E_USER and E2E_PASSWORD");

  // one sign-in for the whole group: the login endpoint allows ten attempts a minute per address
  let cookies: Awaited<ReturnType<BrowserContext["cookies"]>> = [];
  test.beforeAll(async ({ browser }) => {
    const { context, page } = await newPage(browser);
    try {
      await loginAs(page, USER, PASSWORD);
      cookies = await context.cookies();
    } finally {
      await context.close();
    }
  });
  test.beforeEach(async ({ context, page }) => {
    await context.addCookies(cookies);
    await stopActive(page);
  });
  test.afterEach(async ({ page }) => {
    await stopActive(page);
  });

  test("engineer fixes nginx-502 end to end", async ({ page }) => {
    await page.goto("/scenarios");
    const card = page.getByTestId("scenario-nginx-502-upstream");
    await expect(card).toBeVisible();
    const t0 = Date.now();
    await card.getByTestId("scenario-details").click();
    await expect(page.getByTestId("scenario-detail")).toBeVisible();
    await page.getByTestId("start-session").click();

    await expect(page).toHaveURL(/\/sessions\//);
    await expect(page.getByTestId("session-status")).toHaveText("идёт", { timeout: 60_000 });
    const startupSeconds = (Date.now() - t0) / 1000;
    console.log(`session RUNNING after ${startupSeconds.toFixed(1)} s (incl. page navigation)`);
    expect(startupSeconds).toBeLessThan(START_LIMIT_SEC);

    // terminal connects and shows a shell prompt for the on-call user
    await expect(page.getByTestId("terminal-status")).toHaveText("подключён");
    await typeInTerminal(page, "whoami");
    await expect(page.getByTestId("terminal")).toContainText("oncall");

    // the keyboard is not trapped: a double Escape leaves the terminal for the Check button (WCAG 2.1.2)
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("check")).toBeFocused();
    await page.waitForTimeout(600); // readline drops a lone Escape after 500 ms; typing sooner would make it a Meta key

    // hardened sandbox: /usr/bin is read-only even for root
    await typeInTerminal(page, "sudo touch /usr/bin/evil");
    await expect(page.getByTestId("terminal")).toContainText("Read-only file system");

    // check before fixing -> not solved
    await page.getByTestId("check").click();
    await expect(page.getByTestId("check-result")).toContainText("Не решено");
    await expect(page.getByTestId("check-result")).toContainText("502");

    // hint level 1 is free
    await page.getByTestId("hint-1").click();
    await expect(page.getByText(/Направление:/)).toBeVisible();

    // fix like a real engineer would
    await typeInTerminal(page, "sudo sed -i 's/127.0.0.1:8082/127.0.0.1:8081/' /etc/nginx/sites-available/default && sudo service nginx reload");
    await expect(page.getByTestId("terminal")).toContainText("Reloading nginx");

    await page.getByTestId("check").click();
    await expect(page.getByTestId("check-result")).toContainText("Решено");
    await expect(page.getByTestId("session-status")).toHaveText("решено");
    await expect(page.getByTestId("check-result")).toContainText("Баллы: 100");

    // debrief appears only after the session is over
    await expect(page.getByTestId("debrief")).toContainText("Что было сломано", { timeout: 20_000 });
    // the hint opened before the end is still readable after a reload of the finished session
    await page.reload();
    await expect(page.getByText(/Направление:/)).toBeVisible();
    await page.screenshot({ path: "test-results/solved.png", fullPage: true }); // evidence; the html reporter wipes e2e-report/

    // history has the row, and the catalogue remembers the solved scenario
    await page.goto("/history");
    const row = page.getByRole("row").filter({ hasText: "Nginx отдаёт 502" }).first();
    await expect(row).toContainText("решено");
    await expect(row.getByTestId("history-retry")).toBeVisible();
    await page.goto("/scenarios");
    await expect(page.getByTestId("scenario-nginx-502-upstream").getByTestId("progress-solved")).toContainText("решено");
    await expect(page.getByTestId("solved-count")).toContainText("решено");
  });

  test("a second stand is refused while one is running", async ({ page }) => {
    // the start button of a second scenario rendered before the first session exists
    const other = await page.context().newPage();
    await other.goto("/scenarios/disk-full");
    await expect(other.getByTestId("start-session")).toBeVisible();

    await page.goto("/scenarios/nginx-502-upstream");
    await page.getByTestId("start-session").click();
    await expect(page).toHaveURL(/\/sessions\//);

    await other.getByTestId("start-session").click();
    await expect(other.getByText("У тебя уже идёт сессия")).toBeVisible();
    await other.close();
  });

  test("giving up opens the debrief and offers the way back", async ({ page }) => {
    await page.goto("/scenarios/nginx-502-upstream");
    await page.getByTestId("start-session").click();
    await expect(page.getByTestId("session-status")).toHaveText("идёт", { timeout: 60_000 });
    await expect(page.getByTestId("stop")).toHaveText("Сдаться и открыть разбор");
    page.once("dialog", (d) => d.accept());
    await page.getByTestId("stop").click();
    await expect(page.getByTestId("session-status")).toHaveText("остановлена");
    await expect(page.getByTestId("debrief")).toBeVisible({ timeout: 20_000 });
  });

  test("the catalogue has a heading, named filter groups and cards in lists", async ({ page }) => {
    await page.goto("/scenarios");
    await expect(page.getByRole("heading", { level: 1, name: "Сценарии" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Уровень" })).toBeVisible();
    await expect(page.getByRole("list").first().getByRole("listitem").first()).toBeVisible();
    // a filter shows its state by more than colour: the pressed chip gets a tick
    const chip = page.getByTestId("filter-tutorial");
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(chip).toContainText("✓");
  });

  test("the wheel picks a scenario from the filtered pool", async ({ page }) => {
    await page.goto("/scenarios");
    await page.getByTestId("tab-random").click();
    await page.getByTestId("spin").click();
    await expect(page.getByTestId("wheel-result")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("wheel-result").getByTestId("scenario-details")).toBeVisible();
  });

  test("the app pages fit a phone screen", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    for (const url of ["/scenarios", "/history", "/author", "/scenarios/nginx-502-upstream"]) {
      await page.goto(url);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `horizontal scroll on ${url}`).toBeLessThanOrEqual(0);
    }
  });

  test("a Kubernetes teaching case opens its help stage by stage", async ({ page }) => {
    test.skip(!KIND, "set E2E_KIND=1: the test takes a kind slot");
    await page.goto("/scenarios/broken-probes-tutorial");
    await page.getByTestId("start-session").click();
    await expect(page).toHaveURL(/\/sessions\//);
    // the help panel is there while the cluster is still coming up
    await expect(page.getByTestId("guide")).toContainText("0 / ");
    await page.getByTestId("guide-next").click();
    await expect(page.getByTestId("guide-stage-1")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("guide-stage-1")).toBeVisible(); // remembered in the browser
    // the stand is cancelled by afterEach
  });
});

// ---------------------------------------------------------------- moderation and administration

test.describe("admin", () => {
  test.skip(!ADMIN || !USER, "set E2E_USER and E2E_ADMIN with their passwords");

  test("author cabinet: upload a scenario zip, moderator tests and publishes it", async ({ browser }) => {
    test.setTimeout(240_000);
    const slug = "e2e-nginx-copy";
    publishedSlugs.push(slug);
    const author = await newPage(browser);
    const admin = await newPage(browser);
    try {
      await loginAs(author.page, USER, PASSWORD);
      await author.page.goto("/author");
      await expect(author.page.getByTestId("author-skill-link")).toHaveAttribute("href", "/api/author/skill");
      await upload(author.page, slug);

      // moderator: test and publish live on the submission page, next to its files
      await loginAs(admin.page, ADMIN, ADMIN_PASSWORD);
      const detail = await openSubmission(admin.page, slug);
      await expect(detail.getByTestId("submission-files")).toContainText("image/Dockerfile");
      await expect(detail.getByTestId("submission-files")).toContainText(`slug: ${slug}`);
      await expect(detail.getByTestId("submission-archive")).toHaveAttribute("href", /\/api\/admin\/submissions\/[^/]+\/archive$/);
      await detail.getByTestId("submission-test").click();
      await expect(detail.getByTestId("admin-submission-status")).toHaveText("проверка пройдена", { timeout: 180_000 });
      await detail.getByTestId("submission-approve").click();
      await expect(detail.getByTestId("admin-submission-status")).toHaveText("опубликован");

      await author.page.goto("/scenarios");
      await expect(author.page.getByTestId(`scenario-${slug}`)).toBeVisible();
    } finally {
      await author.context.close();
      await admin.context.close();
    }
  });

  test("a rejected submission shows the moderator's note to the author", async ({ browser }) => {
    const slug = "e2e-reject-copy";
    const note = "e2e: отклонено автоматическим тестом";
    const author = await newPage(browser);
    const admin = await newPage(browser);
    try {
      await loginAs(author.page, USER, PASSWORD);
      await upload(author.page, slug);

      await loginAs(admin.page, ADMIN, ADMIN_PASSWORD);
      const detail = await openSubmission(admin.page, slug);
      await detail.getByPlaceholder("комментарий автору").fill(note);
      await detail.getByTestId("submission-reject").click();
      await expect(detail.getByTestId("admin-submission-status")).toHaveText("отклонён");

      await author.page.goto("/author");
      const card = author.page.getByTestId(`submission-${slug}`).first();
      await expect(card.getByTestId("submission-status")).toHaveText("отклонён");
      await expect(card).toContainText(note);
    } finally {
      await author.context.close();
      await admin.context.close();
    }
  });

  test("an administrator can stop a player's session", async ({ browser }) => {
    const player = await newPage(browser);
    const admin = await newPage(browser);
    try {
      await loginAs(player.page, USER, PASSWORD);
      await stopActive(player.page);
      await player.page.goto("/scenarios/nginx-502-upstream");
      await player.page.getByTestId("start-session").click();
      await expect(player.page.getByTestId("session-status")).toHaveText("идёт", { timeout: 60_000 });

      await loginAs(admin.page, ADMIN, ADMIN_PASSWORD);
      await admin.page.goto("/admin/sessions");
      const row = admin.page.getByRole("row").filter({ hasText: USER }).filter({ hasText: ACTIVE_ROW }).first();
      admin.page.once("dialog", (d) => d.accept());
      await row.getByTestId("session-kill").click();

      // the player's page notices at the next poll (10 s while running)
      await expect(player.page.getByTestId("session-status")).toHaveText("остановлена", { timeout: 30_000 });
    } finally {
      await player.context.close();
      await admin.context.close();
    }
  });

  test("a disabled account cannot sign in", async ({ browser }) => {
    const name = uniqueName("e2e-off");
    createdUsers.push(name);
    const fresh = await newPage(browser);
    const admin = await newPage(browser);
    try {
      await register(fresh.page, name);

      await loginAs(admin.page, ADMIN, ADMIN_PASSWORD);
      await admin.page.goto(`/admin/users?q=${encodeURIComponent(name)}`);
      admin.page.once("dialog", (d) => d.accept());
      await admin.page.getByTestId(`user-${name}`).getByTestId("user-disable").click();
      await expect(admin.page.getByTestId(`user-${name}`)).toContainText("отключён");

      const again = await newPage(browser);
      try {
        await again.page.goto("/login");
        await expect(again.page.locator("form[data-hydrated='true']")).toBeVisible();
        await again.page.getByLabel("Имя пользователя").fill(name);
        await again.page.getByLabel("Пароль").fill("correct-horse-battery");
        await again.page.getByRole("button", { name: "Войти" }).click();
        await expect(again.page.getByRole("alert").filter({ hasText: "отключена" })).toBeVisible();
        await expect(again.page).toHaveURL(/\/login/);
      } finally {
        await again.context.close();
      }
    } finally {
      await fresh.context.close();
      await admin.context.close();
    }
  });
});
