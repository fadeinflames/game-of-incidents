/**
 * The integration tests run Reconciler.run() and AccountJanitor.run() over whole tables: on the production database they
 * would mark live sessions KILLED and disable real accounts. So a database whose name has no "test" in it is refused,
 * unless the operator says in so many words that it is a throwaway one.
 */
export function assertTestDatabase(url: string, env: NodeJS.ProcessEnv = process.env): void {
  // never print the URL itself: it carries the password
  const dbName = url.replace(/[?#].*$/, "").split("/").pop() ?? "";
  if (/test/i.test(dbName)) return;
  if (env.WOM_TEST_ALLOW_ANY_DB === "1") return;
  throw new Error(
    `[wom-test] refusing to run: database "${dbName}" does not look like a test database (its name has no "test", e.g. wom_test). ` +
      "The integration tests delete rows and kill every active session, so they must not touch dev or production data. " +
      "Point DATABASE_URL at a dedicated test database, or set WOM_TEST_ALLOW_ANY_DB=1 if this one really is disposable.",
  );
}
