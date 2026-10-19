import { NextResponse } from "next/server";
import { clearSession } from "@/lib/auth";
import { crossOriginResponse } from "@/lib/http";

export async function POST(req: Request) {
  const foreign = crossOriginResponse(req);
  if (foreign) return foreign;
  await clearSession();
  return NextResponse.json({ ok: true });
}
