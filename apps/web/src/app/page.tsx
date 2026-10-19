// Landing: what the platform is for and how a session works. Public; signed-in users get a shortcut to the catalog.
import Link from "next/link";
import { prisma } from "@wom/db";
import { getCurrentUser } from "@/lib/auth";
import { SiteFooter } from "@/components/site-footer";
import { tone } from "@/lib/tones";

export const dynamic = "force-dynamic";

const STEP_TONES = ["var(--accent)", "var(--k8s)", "var(--linux)", "var(--ok)"];
const FEATURE_ICONS = ["🎓", "🧪", "📈", "📦", "🛡️", "🌍"];
const FEATURE_TONES = ["var(--ok)", "var(--accent)", "var(--k8s)", "var(--linux)", "var(--senior)", "var(--junior)"];

const STEPS = [
  {
    n: "1",
    title: "Выбери сценарий или крути колесо",
    text: "Каталог по уровням Junior / Middle / Senior и по типу окружения: Linux‑хост или кластер Kubernetes. Не хочешь выбирать — колесо неудач выберет само.",
  },
  {
    n: "2",
    title: "Окружение поднимается для тебя",
    text: "Каждая сессия получает свой изолированный стенд: контейнер с Debian или кластер kind с приложениями. Linux‑хост стартует за секунды, кластер за одну-три минуты (время указано на странице сценария), и в нём уже что‑то сломано.",
  },
  {
    n: "3",
    title: "Диагностируй и чини в терминале",
    text: "Обычный shell в браузере под пользователем oncall с sudo или kubectl. Логи, ss, df, describe, edit: всё как на настоящем дежурстве. Подсказки трёх уровней по желанию, первая бесплатная.",
  },
  {
    n: "4",
    title: "Нажми «Проверить» и прочитай разбор",
    text: "Грейдер смотрит на результат, а не на способ: любой честный путь засчитывается, ловушки вроде «убрать пробу» — нет. После решения открывается разбор: что было сломано, как диагностируется, эталонное решение, чему учит.",
  },
];

const FEATURES = [
  { title: "Учебные копии для новичков", text: "У junior‑кейсов две версии: обычная и учебная с панелью «Нужна помощь?», которая открывает этапы диагностики по одному и объясняет, зачем нужна каждая команда, плюс шпаргалка и что почитать заранее." },
  { title: "Кейсы из настоящих инцидентов", text: "Сломанные пробы, квота, съевшая релиз, шторм из CronJob, фантомная сеть с каскадом таймаутов. Каждый сценарий проходит регресс: свежий стенд не решён, эталонное решение решает, ловушки не проходят." },
  { title: "Баллы и история", text: "Сценарий даёт 100 баллов, открытые подсказки снимают свой штраф. История сессий хранит результат, время и разбор, чтобы вернуться к кейсу позже." },
  { title: "Свои сценарии", text: "Сценарий — это папка: описание, Dockerfile или манифесты, скрипты поломки, проверки и решения. Есть готовый промпт для LLM, который собирает папку из пост‑мортема. Загрузи zip: модератор прогонит регресс и опубликует." },
  { title: "Изолированные стенды", text: "Каждая сессия работает в отдельном контейнере или кластере под rootless‑Docker, без выхода в интернет и с лимитами CPU и памяти. Стенд сам удаляется по истечении времени жизни: у большинства сценариев это 45 минут. Скрипты проверки не лежат на диске стенда." },
  { title: "Без почты и без оплаты", text: "Регистрация по логину и паролю, почта не нужна. Платных уровней нет." },
];

export default async function Home() {
  const user = await getCurrentUser();
  // a teaching copy ("tutorial" tag) is the same case as its regular twin: it is not counted a second time
  const playable = { isPublished: true, NOT: { tags: { has: "tutorial" } } };
  const [scenarios, kubernetes] = await Promise.all([
    prisma.scenario.count({ where: { ...playable, environmentJson: { not: { equals: null } } } }),
    prisma.scenario.count({ where: { ...playable, environmentJson: { path: ["kind"], equals: "kubernetes" } } }),
  ]);

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16">
      <header className="flex items-center justify-between py-4 text-sm">
        <span className="flex items-center gap-2 font-bold tracking-wide">
          <span
            aria-hidden="true"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[13px] font-extrabold text-[#1a1000] shadow-[0_4px_14px_-4px_rgba(240,180,41,0.8)]"
            style={{ background: "linear-gradient(135deg, #ffc94d, #fb923c)" }}
          >
            !
          </span>
          Game of Incidents
        </span>
        <nav className="flex items-center gap-3">
          {user ? (
            <>
              <span style={{ color: "var(--muted)" }}>{user.username}</span>
              <Link href="/scenarios" className="btn btn-primary no-underline">
                К сценариям
              </Link>
            </>
          ) : (
            <>
              <Link href="/login" className="btn no-underline">
                Войти
              </Link>
              <Link href="/register" className="btn btn-primary no-underline">
                Создать аккаунт
              </Link>
            </>
          )}
        </nav>
      </header>

      <main>
        <section className="grid items-center gap-10 py-10 md:grid-cols-[1.05fr_0.95fr] md:py-16">
          <div>
            <p className="eyebrow mb-3">Game of Incidents · тренажёр для инженеров и дежурных</p>
            <h1 className="mb-4 text-4xl font-extrabold leading-[1.1] md:text-[2.7rem]">
              Учись чинить инциденты <span className="grad-text">на живых стендах</span>
            </h1>
            <p className="mb-6 max-w-xl text-base md:text-lg" style={{ color: "var(--muted)" }}>
              Тренажёр с живыми окружениями: дежурный получает сломанную систему и терминал. На кейс уходит около 20 минут, стенд сам удаляется через 45. Чинить нужно по‑настоящему, а не на словах: платформа поднимает
              изолированный Linux‑хост или кластер Kubernetes, ломает его по сценарию и проверяет результат.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link href={user ? "/scenarios" : "/register"} className="btn btn-primary px-5 py-2.5 no-underline" data-testid="landing-cta">
                {user ? "Открыть каталог" : "Создать аккаунт и начать"} <span aria-hidden="true">→</span>
              </Link>
              {!user && (
                <Link href="/login" className="btn px-5 py-2.5 no-underline">
                  У меня есть аккаунт
                </Link>
              )}
              <a href="#how" className="text-sm">
                Как это устроено
              </a>
            </div>
            {!user && (
              <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
                Регистрация по логину и паролю, почта не нужна. Платных уровней нет.
              </p>
            )}
            <dl className="mt-7 flex flex-wrap gap-3 text-sm">
              <div className="panel px-4 py-2.5" style={tone("var(--accent)")}>
                <dt className="text-xs" style={{ color: "var(--muted)" }}>
                  сценариев
                </dt>
                <dd className="text-xl font-extrabold" style={{ color: "var(--tone)" }}>
                  {scenarios}
                </dd>
              </div>
              <div className="panel px-4 py-2.5" style={tone("var(--k8s)")}>
                <dt className="text-xs" style={{ color: "var(--muted)" }}>
                  из них на Kubernetes
                </dt>
                <dd className="text-xl font-extrabold" style={{ color: "var(--tone)" }}>
                  {kubernetes}
                </dd>
              </div>
              <div className="panel px-4 py-2.5" style={tone("var(--junior)")}>
                <dt className="text-xs" style={{ color: "var(--muted)" }}>
                  уровня сложности
                </dt>
                <dd className="text-xl font-extrabold" style={{ color: "var(--tone)" }}>
                  3
                </dd>
              </div>
            </dl>
            <p className="mt-4 max-w-xl text-xs" style={{ color: "var(--muted)" }} data-testid="desktop-note">
              Терминал удобнее на компьютере: с телефона можно читать описания и разборы, а решать лучше за клавиатурой.
            </p>
          </div>

          <div
            className="overflow-hidden rounded-xl border border-[var(--border)] bg-inset shadow-[0_30px_80px_-30px_rgba(99,102,241,0.55)]"
            aria-label="Пример сессии: nginx отдаёт 502"
            role="img"
          >
            <div className="flex items-center gap-1.5 border-b border-[var(--border)] bg-[var(--panel)] px-4 py-2.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
              <span className="ml-3 font-mono text-xs" style={{ color: "var(--muted)" }}>
                oncall@web-01
              </span>
            </div>
            <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[12.5px] leading-relaxed">
              <span style={{ color: "var(--ok)" }}>$</span> curl -sI localhost{"\n"}
              <span style={{ color: "var(--bad)" }}>HTTP/1.1 502 Bad Gateway</span>
              {"\n"}
              <span style={{ color: "var(--ok)" }}>$</span> sudo tail -n2 /var/log/nginx/error.log{"\n"}
              <span style={{ color: "var(--muted)" }}>connect() failed (111: Connection refused)</span>
              {"\n"}
              <span style={{ color: "var(--muted)" }}>while connecting to upstream 127.0.0.1:8082</span>
              {"\n"}
              <span style={{ color: "var(--ok)" }}>$</span> sudo ss -ltnp | grep 808{"\n"}
              <span style={{ color: "var(--k8s)" }}>LISTEN 0 128 127.0.0.1:8081 users:(("python3"))</span>
              {"\n"}
              <span style={{ color: "var(--ok)" }}>$</span> sudo sed -i <span style={{ color: "var(--accent)" }}>{"'s/8082/8081/'"}</span> /etc/nginx/sites-available/default{"\n"}
              <span style={{ color: "var(--ok)" }}>$</span> sudo service nginx reload{"\n"}
              {"\n"}
              <span style={{ color: "var(--accent)" }}>▸ Проверить</span>
              {"  "}
              <span style={{ color: "var(--ok)" }}>✓ 4 из 4 критериев · решено · 100 баллов</span>
            </pre>
          </div>
        </section>

        <section id="how" className="scroll-mt-4 py-8">
          <h2 className="mb-5 text-xl font-bold">Как проходит сессия</h2>
          <ol className="grid gap-4 md:grid-cols-2">
            {STEPS.map((s) => (
              <li key={s.n} className="panel tile p-5" style={tone(STEP_TONES[Number(s.n) - 1])}>
                <div className="mb-2 flex items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full text-sm font-extrabold" style={{ background: "var(--tone)", color: "#0a0e17" }}>
                    {s.n}
                  </span>
                  <h3 className="font-semibold">{s.title}</h3>
                </div>
                <p className="text-sm" style={{ color: "var(--muted)" }}>
                  {s.text}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section className="py-8">
          <h2 className="mb-5 text-xl font-bold">Зачем это нужно</h2>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="panel p-5">
              <h3 className="mb-2 flex items-center gap-3 font-semibold">
                <span className="icon-chip" style={tone("var(--junior)")} aria-hidden="true">
                  🛠️
                </span>
                Инженеру
              </h3>
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                Набить руку на инцидентах до того, как они случатся на проде. Учебные кейсы ведут за руку, обычные проверяют, что руки помнят.
              </p>
            </div>
            <div className="panel p-5">
              <h3 className="mb-2 flex items-center gap-3 font-semibold">
                <span className="icon-chip" style={tone("var(--k8s)")} aria-hidden="true">
                  👥
                </span>
                Команде
              </h3>
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                Открытый каталог кейсов из настоящих инцидентов: новому человеку лучше пройти их здесь, чем впервые встретить в три часа ночи. Закрытых каталогов для отдельной команды пока нет: всё, что опубликовано, видно всем.
              </p>
            </div>
            <div className="panel p-5">
              <h3 className="mb-2 flex items-center gap-3 font-semibold">
                <span className="icon-chip" style={tone("var(--linux)")} aria-hidden="true">
                  🧭
                </span>
                Ментору
              </h3>
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                Описал инцидент, прогнал через готовый промпт, загрузил папку. Когда модератор проверит сценарий, у людей появляется живой стенд с разбором и подсказками.
              </p>
            </div>
          </div>
        </section>

        <section className="py-8">
          <h2 className="mb-5 text-xl font-bold">Что внутри</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {FEATURES.map((f, i) => (
              <div key={f.title} className="panel p-5">
                <h3 className="mb-2 flex items-center gap-3 font-semibold">
                  <span className="icon-chip" style={tone(FEATURE_TONES[i % FEATURE_TONES.length])} aria-hidden="true">
                    {FEATURE_ICONS[i % FEATURE_ICONS.length]}
                  </span>
                  {f.title}
                </h3>
                <p className="text-sm" style={{ color: "var(--muted)" }}>
                  {f.text}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="py-8">
          <div className="panel flex flex-col items-start gap-3 p-6 md:flex-row md:items-center md:justify-between" style={{ background: "linear-gradient(120deg, rgba(240,180,41,0.14), rgba(99,102,241,0.14))", borderColor: "rgba(240,180,41,0.35)" }}>
            <div>
              <h2 className="text-lg font-bold">Готов дежурить?</h2>
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                Логин, пароль, и можно запускать первый сценарий.
              </p>
            </div>
            <Link href={user ? "/scenarios" : "/register"} className="btn btn-primary no-underline">
              {user ? "Открыть каталог" : "Создать аккаунт и начать"}
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter signedIn={Boolean(user)} />
    </div>
  );
}
