import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import { scanSource } from "@/lib/scanner";

export const maxDuration = 300;

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.fullAccess) return NextResponse.json({ error: "Yetkisiz erişim." }, { status: 401 });

  try {
    const { id } = await context.params;
    const result = await scanSource(id);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tarama başarısız oldu.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
