import { describe, expect, it } from "vitest";
import { checkAnnouncement } from "@/lib/announce";
import { archiveProblem } from "@/lib/upload-check";

const ok = (id: string, message: string) => ({ id, ok: true, message });
const bad = (id: string, message: string) => ({ id, ok: false, message });

describe("checkAnnouncement", () => {
  it("is silent while there is no verdict", () => {
    expect(checkAnnouncement(null, 0)).toBe("");
  });

  it("names the criteria that are not met", () => {
    const text = checkAnnouncement({ status: "ok", passed: false, criteria: [ok("a", "Сайт отвечает"), bad("b", "Порт 8081 слушает."), bad("c", "Лог без ошибок")] }, 1);
    expect(text).toBe("Проверка 1. Не решено: выполнено 1 из 3. Не выполнено: Порт 8081 слушает; Лог без ошибок.");
  });

  it("a repeated verdict with the same numbers is a different text, so a live region speaks it again", () => {
    const result = { status: "ok" as const, passed: false, criteria: [ok("a", "A"), bad("b", "B")] };
    expect(checkAnnouncement(result, 2)).not.toBe(checkAnnouncement(result, 3));
  });

  it("keeps a long list short", () => {
    const text = checkAnnouncement({ status: "ok", passed: false, criteria: [bad("1", "один"), bad("2", "два"), bad("3", "три"), bad("4", "четыре"), bad("5", "пять")] }, 1);
    expect(text).toContain("один; два; три и ещё 2.");
    expect(text).not.toContain("четыре");
  });

  it("a solved check has nothing left to name", () => {
    expect(checkAnnouncement({ status: "ok", passed: true, criteria: [ok("a", "A")] }, 4)).toBe("Проверка 4. Решено: выполнено 1 из 1.");
  });

  it("says when the check itself failed", () => {
    expect(checkAnnouncement({ status: "error", error: "x" }, 2)).toBe("Проверка 2. Проверка не удалась. Попробуй ещё раз.");
  });

  it("leaves out the number when the attempts are unknown", () => {
    expect(checkAnnouncement({ status: "ok", passed: true, criteria: [] }, 0)).toBe("Решено: выполнено 0 из 0.");
  });
});

describe("archiveProblem", () => {
  const MB = 1024 * 1024;

  it("accepts a zip within the limit", () => {
    expect(archiveProblem({ name: "case.zip", size: 2 * MB }, 5 * MB)).toBeNull();
    expect(archiveProblem({ name: "CASE.ZIP", size: 5 * MB }, 5 * MB)).toBeNull();
  });

  it("refuses a large file before it is sent, naming both sizes", () => {
    const text = archiveProblem({ name: "case.zip", size: 7.5 * MB }, 5 * MB);
    expect(text).toContain("7.5 МБ");
    expect(text).toContain("до 5 МБ");
  });

  it("refuses an empty file and a file that is not a zip", () => {
    expect(archiveProblem({ name: "case.zip", size: 0 }, 5 * MB)).toContain("пустой");
    expect(archiveProblem({ name: "case.tar.gz", size: 1000 }, 5 * MB)).toContain(".zip");
  });
});
