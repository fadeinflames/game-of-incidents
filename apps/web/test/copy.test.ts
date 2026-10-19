// Interface copy that must stay true to the product: counters match the catalogue, no unconfirmed promises, the sign-in form says what it takes.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScenariosView, type ScenarioCard } from "@/components/scenarios-view";
import { AuthForm } from "@/components/auth-form";

const count = vi.fn(async (_args: unknown) => 22);
vi.mock("@wom/db", () => ({ prisma: { scenario: { count: (args: unknown) => count(args) } } }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

const landing = async () => {
  const { default: Home } = await import("@/app/page");
  return renderToStaticMarkup(await Home());
};

describe("landing page", () => {
  beforeEach(() => count.mockClear());

  it("counts a case once: the teaching copies are left out of both counters", async () => {
    await landing();
    expect(count).toHaveBeenCalledTimes(2);
    for (const [args] of count.mock.calls) {
      expect(args).toMatchObject({ where: { isPublished: true, NOT: { tags: { has: "tutorial" } } } });
    }
  });

  it("names the reader and the benefit in the first heading", async () => {
    const html = await landing();
    const h1 = html.match(/<h1[^>]*>([^]*?)<\/h1>/)?.[1].replace(/<[^>]+>/g, "") ?? "";
    expect(h1).toMatch(/чинить/i);
    expect(html).toContain("тренажёр для инженеров и дежурных");
  });

  it("carries no promise the product does not keep", async () => {
    const html = await landing();
    for (const claim of ["Безопасно по умолчанию", "Открытый проект", "open source", "через час", "за неделю", "через минуту"]) {
      expect(html, claim).not.toContain(claim);
    }
  });

  it("the call to action says what happens next and where to read how it works", async () => {
    const html = await landing();
    expect(html).toContain("Создать аккаунт и начать");
    expect(html).toContain('href="#how"');
    expect(html).toContain('id="how"');
  });
});

describe("sign-in and sign-up forms", () => {
  it("the sign-in field is the username (accounts are created without an email)", () => {
    const html = renderToStaticMarkup(createElement(AuthForm, { mode: "login" }));
    expect(html).not.toMatch(/Email или/);
    expect(html).toContain("Имя пользователя");
  });

  it("the sign-up form says there is no email and that the password cannot be recovered by oneself", () => {
    const html = renderToStaticMarkup(createElement(AuthForm, { mode: "register" }));
    expect(html).toContain("Почта не нужна");
    expect(html).toMatch(/Почты нет, пароль сам не восстановить/);
  });
});

const card = (over: Partial<ScenarioCard>): ScenarioCard => ({
  id: "1",
  slug: "nginx-502",
  title: "Nginx отдаёт 502",
  summary: "Сайт не открывается",
  type: "linux",
  difficulty: "JUNIOR",
  durationMin: 20,
  tags: [],
  kind: "container",
  startupSec: null,
  progress: null,
  ...over,
});

describe("catalogue copy", () => {
  const withTutorial = renderToStaticMarkup(
    createElement(ScenariosView, { scenarios: [card({}), card({ id: "2", slug: "nginx-502-tutorial", tags: ["tutorial"] })], capacity: null }),
  );

  it("tells a newcomer where to start when there is a teaching copy", () => {
    expect(withTutorial).toContain("С чего начать");
    expect(withTutorial).toContain("Показать учебные Junior");
  });

  it("does not point to teaching copies that do not exist", () => {
    const html = renderToStaticMarkup(createElement(ScenariosView, { scenarios: [card({})], capacity: null }));
    expect(html).not.toContain("С чего начать");
  });

  it("names the two ways to choose plainly", () => {
    expect(withTutorial).toContain("Выбрать самому");
    expect(withTutorial).toContain("Случайный сценарий");
    expect(withTutorial).not.toContain("Сам решууу");
    expect(withTutorial).not.toContain("(нет)");
  });
});
