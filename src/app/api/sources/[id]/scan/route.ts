import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

// Queues a scan; the long-running work happens in the worker process (`npm run worker`).
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.fullAccess) return NextResponse.json({ error: "Yetkisiz erişim." }, { status: 401 });

  const { id } = await context.params;
  const source = await prisma.sourceSite.findUnique({ where: { id }, select: { id: true } });
  if (!source) return NextResponse.json({ error: "Kaynak bulunamadı." }, { status: 404 });

  const active = await prisma.scanJob.findFirst({ where: { sourceSiteId: id, status: { in: ["QUEUED", "RUNNING"] } } });
  if (active) return NextResponse.json({ error: "Bu kaynak için zaten devam eden bir tarama var." }, { status: 409 });

  const job = await prisma.scanJob.create({ data: { sourceSiteId: id } });
  return NextResponse.json(job, { status: 202 });
}
