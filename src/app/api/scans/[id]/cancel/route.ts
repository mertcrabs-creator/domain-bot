import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.fullAccess) return NextResponse.json({ error: "Yetkisiz erişim." }, { status: 401 });

  const { id } = await context.params;
  const { count } = await prisma.scanJob.updateMany({
    where: { id, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "CANCELLED", finishedAt: new Date(), lastMessage: "Kullanıcı tarafından durduruldu" },
  });
  if (count === 0) return NextResponse.json({ error: "Aktif tarama bulunamadı." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
