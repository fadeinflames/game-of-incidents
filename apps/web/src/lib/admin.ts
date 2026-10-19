// Admin-only helpers for API routes and pages.
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { getCurrentUser, requireUser, type CurrentUser } from "./auth";
import { crossOriginResponse, unauthorized } from "./http";

export { ACTIVE_SESSION_STATUSES } from "./labels";

/** API routes: the current user or a 401/403 response. Mutating handlers pass the request so it is also checked for a foreign origin. */
export async function requireAdminApi(req?: Request): Promise<{ user: CurrentUser } | { response: NextResponse }> {
  const foreign = req ? crossOriginResponse(req) : null;
  if (foreign) return { response: foreign };
  const user = await getCurrentUser();
  if (!user) return { response: unauthorized() };
  if (user.role !== "admin") return { response: NextResponse.json({ error: "только для администратора" }, { status: 403 }) };
  return { user };
}

/** pages: redirects non-admins to the catalog */
export async function requireAdminPage(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/scenarios");
  return user;
}
