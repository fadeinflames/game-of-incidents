// `wom scenario push`: packs a scenario folder and sends it to a running platform through its web API, so that an author
// (or an agent working for them) does not have to click through the site. The steps mirror the cabinet:
//   upload (every user) -> test = build + regression on the platform (administrator) -> approve = publish (administrator)
//   -> start a session (every user, only for a published scenario).
// Credentials come from the caller (the CLI reads them from the environment, never from arguments) and are used only for the login.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { zipSync, type Zippable } from "fflate";
import { ArchiveError, EXTRACT_MAX_BYTES, EXTRACT_MAX_FILE_BYTES, EXTRACT_MAX_FILES, ZIP_MAX_BYTES } from "./archive";

export class PushError extends Error {}

/** names that never go into the archive (the platform ignores them as well) */
function isJunk(name: string): boolean {
  return name === "__MACOSX" || name === ".DS_Store" || name.startsWith("._") || name.startsWith(".git") || name === "node_modules";
}

/** zip of the scenario folder with scenario.yaml at the root, within the limits the platform checks on upload */
export function packScenarioDir(dir: string): Uint8Array {
  const root = path.resolve(dir);
  const files: Zippable = {};
  let count = 0;
  let bytes = 0;
  const walk = (current: string, prefix: string) => {
    for (const name of readdirSync(current).sort()) {
      if (isJunk(name)) continue;
      const full = path.join(current, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new ArchiveError(`символическая ссылка в папке сценария: ${prefix}${name}`);
      if (st.isDirectory()) {
        walk(full, `${prefix}${name}/`);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > EXTRACT_MAX_FILE_BYTES) throw new ArchiveError(`файл больше ${EXTRACT_MAX_FILE_BYTES / 1024 / 1024} МБ: ${prefix}${name}`);
      count++;
      bytes += st.size;
      if (count > EXTRACT_MAX_FILES) throw new ArchiveError(`в папке больше ${EXTRACT_MAX_FILES} файлов`);
      if (bytes > EXTRACT_MAX_BYTES) throw new ArchiveError(`папка больше ${EXTRACT_MAX_BYTES / 1024 / 1024} МБ`);
      files[`${prefix}${name}`] = readFileSync(full);
    }
  };
  walk(root, "");
  if (!files["scenario.yaml"]) throw new ArchiveError(`в ${dir} нет scenario.yaml`);
  const zip = zipSync(files, { level: 6 });
  if (zip.byteLength > ZIP_MAX_BYTES) throw new ArchiveError(`архив больше ${ZIP_MAX_BYTES / 1024 / 1024} МБ`);
  return zip;
}

export type PushOptions = {
  /** address of the platform, e.g. https://game.example.com */
  url: string;
  user: string;
  password: string;
  zip: Uint8Array;
  /** ask the platform to build the image and run the regression (administrator only) */
  check?: boolean;
  /** publish after a passed check (administrator only); implies check */
  publish?: boolean;
  /** start a session of the published scenario; implies publish */
  start?: boolean;
  /** how long to wait for the check and for the session, seconds */
  waitSec?: number;
  pollMs?: number;
  /** a single HTTP request that takes longer than this is abandoned (default 30 s) */
  requestTimeoutMs?: number;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
};

export type PushResult = {
  ok: boolean;
  submissionId: string;
  slug: string;
  status: string;
  /** what to do next, in one sentence */
  next: string;
  /** the account lacks the administrator role: the upload is done, checking and publishing wait for a moderator */
  needsAdmin?: boolean;
  scenarioUrl?: string;
  sessionUrl?: string;
};

type Json = Record<string, unknown>;
type Submission = { id: string; slug: string; status: string; lintReport?: unknown; testReport?: unknown; moderatorNote?: string | null; scenarioId?: string | null };

const FINAL_CHECK = new Set(["PASSED", "FAILED", "APPROVED", "REJECTED", "LINT_FAILED"]);

function describeIssues(report: unknown, onlyErrors: boolean): string[] {
  if (!Array.isArray(report)) return [];
  return report
    .filter((i): i is { level?: string; rule?: string; message?: string } => typeof i === "object" && i !== null)
    .filter((i) => !onlyErrors || i.level === "error")
    .map((i) => `[${i.rule ?? "?"}] ${i.message ?? ""}`.trim());
}

export async function pushScenario(opts: PushOptions): Promise<PushResult> {
  const log = opts.log ?? (() => {});
  const doFetch = opts.fetchImpl ?? fetch;
  const wantStart = Boolean(opts.start);
  const wantPublish = Boolean(opts.publish) || wantStart;
  const wantCheck = Boolean(opts.check) || wantPublish;
  const pollMs = opts.pollMs ?? 5000;
  const waitMs = (opts.waitSec ?? 900) * 1000;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;

  let base: URL;
  try {
    base = new URL(opts.url);
  } catch {
    // the text is not echoed: it may carry a password (https://user:pass@host)
    throw new PushError("адрес платформы не разобрался: нужен вид https://host");
  }
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) {
    throw new PushError("логин и пароль уходят на адрес без TLS: используй https:// (http:// разрешён только для localhost)");
  }
  const origin = base.origin;
  // cookie jar by name: a later Set-Cookie replaces only its own cookie, an empty value deletes it
  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

  const call = async (method: string, route: string, body?: { json?: Json; form?: FormData }): Promise<{ status: number; body: Json }> => {
    const headers: Record<string, string> = { Origin: origin };
    if (jar.size) headers.Cookie = cookieHeader();
    let payload: BodyInit | undefined;
    if (body?.json) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body.json);
    } else if (body?.form) payload = body.form;
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${origin}${route}`, { method, headers, body: payload, redirect: "manual", signal: AbortSignal.timeout(requestTimeoutMs) });
      text = await res.text();
    } catch (e) {
      const name = (e as Error).name;
      const why = name === "TimeoutError" || name === "AbortError" ? `нет ответа за ${Math.round(requestTimeoutMs / 1000)} с` : (e as Error).message;
      throw new PushError(`платформа не отвечает (${origin}): ${why}`);
    }
    if (res.status >= 300 && res.status < 400) {
      throw new PushError(`платформа перенаправляет запрос (${res.status}): проверь адрес, возможно нужен https:// или другой хост`);
    }
    for (const c of typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []) {
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    }
    let parsed: Json = {};
    try {
      parsed = text ? (JSON.parse(text) as Json) : {};
    } catch {
      parsed = { error: text.slice(0, 200), notJson: true };
    }
    return { status: res.status, body: parsed };
  };
  const errorOf = (r: { status: number; body: Json }) => (typeof r.body.error === "string" ? r.body.error : `HTTP ${r.status}`);

  log(`вход на ${origin} как ${opts.user}`);
  const login = await call("POST", "/api/auth/login", { json: { identity: opts.user, password: opts.password } });
  if (login.status === 401) throw new PushError("неверный логин или пароль");
  if (login.status === 429) throw new PushError(`слишком много попыток входа: ${errorOf(login)}`);
  if (login.status >= 400 || !jar.size) throw new PushError(`вход не удался: ${errorOf(login)}`);

  log(`загрузка архива (${Math.round(opts.zip.byteLength / 1024)} КБ)`);
  const form = new FormData();
  form.set("archive", new Blob([opts.zip.slice().buffer as ArrayBuffer], { type: "application/zip" }), "scenario.zip");
  const up = await call("POST", "/api/author/submissions", { form });
  if (up.status === 429) throw new PushError(`загрузки слишком частые: ${errorOf(up)}`);
  if (up.status >= 400) {
    const issues = Array.isArray(up.body.issues) ? (up.body.issues as unknown[]).map(String) : [];
    throw new PushError([`платформа отклонила архив: ${errorOf(up)}`, ...issues.map((i) => `  - ${i}`)].join("\n"));
  }
  let sub = up.body as unknown as Submission;
  if (up.body.notJson || typeof sub.id !== "string" || typeof sub.slug !== "string") {
    throw new PushError(`платформа ответила на загрузку не так, как ожидалось (HTTP ${up.status}): это не её API, страница обслуживания или прокси; проверь адрес`);
  }
  const submissionId = sub.id;
  const slug = sub.slug;
  const scenarioUrl = `${origin}/scenarios/${slug}`;
  const result = (partial: Partial<PushResult> & Pick<PushResult, "ok" | "status" | "next">): PushResult => ({ submissionId, slug, scenarioUrl: undefined, ...partial });

  if (sub.status === "LINT_FAILED") {
    for (const line of describeIssues(sub.lintReport, true)) log(`  ✗ ${line}`);
    return result({ ok: false, status: sub.status, next: "исправь ошибки линтера и повтори push" });
  }
  for (const line of describeIssues(sub.lintReport, false)) log(`  ! ${line}`);
  log(`заявка ${submissionId} (${slug}) принята, статус ${sub.status}`);

  if (!wantCheck) {
    return result({ ok: true, status: sub.status, next: "заявка ждёт проверки модератором (кнопка «Проверить» на странице заявки); после публикации сценарий появится в каталоге" });
  }

  const own = async (): Promise<Submission> => {
    const list = await call("GET", "/api/author/submissions");
    if (list.status >= 400) throw new PushError(`не удалось прочитать статус заявки: ${errorOf(list)}`);
    const items = (list.body.items as Submission[] | undefined) ?? [];
    const found = items.find((s) => s.id === submissionId);
    if (!found) throw new PushError("заявка пропала из списка");
    return found;
  };

  log("проверка на платформе: сборка образа и регресс (это может занять несколько минут)");
  const test = await call("POST", `/api/admin/submissions/${encodeURIComponent(submissionId)}/test`);
  if (test.status === 403) {
    return result({ ok: false, needsAdmin: true, status: sub.status, next: "для проверки и публикации нужна роль администратора: заявка загружена, попроси модератора нажать «Проверить» и «Опубликовать» на странице заявки" });
  }
  if (test.status === 401) throw new PushError("сессия на платформе потеряна (401): повтори push");
  if (test.status >= 400) throw new PushError(`проверка не запустилась: ${errorOf(test)}`);

  const checkDeadline = Date.now() + waitMs;
  let last = "";
  for (;;) {
    sub = await own();
    if (sub.status !== last) {
      log(`  статус: ${sub.status}`);
      last = sub.status;
    }
    if (FINAL_CHECK.has(sub.status)) break;
    if (Date.now() > checkDeadline) throw new PushError(`проверка не закончилась за отведённое время (последний статус ${sub.status}); смотри заявку на сайте`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (sub.status !== "PASSED") {
    const detail = sub.testReport ? JSON.stringify(sub.testReport).slice(0, 2000) : "";
    if (detail) log(`  отчёт проверки: ${detail}`);
    return result({ ok: false, status: sub.status, next: "регресс не прошёл: исправь сценарий по отчёту (wom scenario test локально) и повтори push" });
  }
  log("проверка пройдена");

  if (!wantPublish) {
    return result({ ok: true, status: sub.status, next: "заявка прошла проверку; опубликуй её на странице заявки или повтори push с --publish" });
  }

  const approve = await call("POST", `/api/admin/submissions/${encodeURIComponent(submissionId)}/approve`);
  if (approve.status >= 400) throw new PushError(`публикация не удалась: ${errorOf(approve)}`);
  const scenarioId = typeof approve.body.scenarioId === "string" ? approve.body.scenarioId : null;
  log(`опубликовано: ${scenarioUrl}`);

  if (!wantStart) {
    return result({ ok: true, status: "APPROVED", scenarioUrl, next: `сценарий в каталоге; запуск: ${scenarioUrl} → «Запустить»` });
  }
  if (!scenarioId) throw new PushError("платформа не вернула id сценария, запусти его на сайте");

  log("запуск сессии");
  const started = await call("POST", "/api/sessions", { json: { scenarioId } });
  if (started.status >= 400) {
    return result({ ok: false, status: "APPROVED", scenarioUrl, next: `сценарий опубликован, но сессию запустить не удалось (${errorOf(started)}); запусти на ${scenarioUrl}` });
  }
  const sessionId = String((started.body as Json).id ?? "");
  let state = "";
  let failures = 0;
  const sessionDeadline = Date.now() + waitMs;
  for (;;) {
    const s = await call("GET", `/api/sessions/${encodeURIComponent(sessionId)}`);
    if (s.status >= 400) {
      failures++;
      if (failures >= 5) throw new PushError(`платформа не отдаёт статус сессии (${errorOf(s)}); смотри ${origin}/sessions/${sessionId}`);
      await new Promise((r) => setTimeout(r, Math.min(pollMs, 3000)));
      continue;
    }
    failures = 0;
    const status = String((s.body as Json).status ?? "");
    if (status !== state) {
      log(`  сессия: ${status}`);
      state = status;
    }
    if (status === "RUNNING") break;
    if (["FAILED", "KILLED", "FINISHED", "EXPIRED"].includes(status)) {
      return result({ ok: false, status: "APPROVED", scenarioUrl, next: `сессия закончилась статусом ${status}: ${String((s.body as Json).lastError ?? "причина на странице сессии")}` });
    }
    if (Date.now() > sessionDeadline) throw new PushError(`стенд не поднялся за отведённое время (статус ${status}); смотри ${origin}/sessions/${sessionId}`);
    await new Promise((r) => setTimeout(r, Math.min(pollMs, 3000)));
  }
  const sessionUrl = `${origin}/sessions/${sessionId}`;
  return result({ ok: true, status: "APPROVED", scenarioUrl, sessionUrl, next: `стенд работает: открой ${sessionUrl}` });
}
