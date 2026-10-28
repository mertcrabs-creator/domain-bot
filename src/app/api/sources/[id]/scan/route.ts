import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

// Queues a scan; the long-running work happens in the worker process (`npm run worker`).
// Without a body it reads the sitemaps (or crawls a CRAWL source); with `{ batch }` it crawls that page batch.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.fullAccess) return NextResponse.json({ error: "Yetkisiz erişim." }, { status: 401 });

  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { batch?: unknown } | null;
  const batch = body?.batch == null ? null : Number(body.batch);
  if (batch !== null && (!Number.isInteger(batch) || batch < 1)) return NextResponse.json({ error: "Geçersiz parça." }, { status: 400 });

  const source = await prisma.sourceSite.findUnique({ where: { id }, select: { id: true, isActive: true } });
  if (!source?.isActive) return NextResponse.json({ error: "Kaynak bulunamadı." }, { status: 404 });
  if (batch !== null && !(await prisma.pageBatch.findUnique({ where: { sourceSiteId_number: { sourceSiteId: id, number: batch } } }))) {
    return NextResponse.json({ error: "Parça bulunamadı." }, { status: 404 });
  }

  const active = await prisma.scanJob.findFirst({ where: { sourceSiteId: id, status: { in: ["QUEUED", "RUNNING"] } } });
  if (active) return NextResponse.json({ error: "Bu kaynak için zaten devam eden bir tarama var." }, { status: 409 });

  const job = await prisma.scanJob.create({ data: { sourceSiteId: id, batch } });
  return NextResponse.json(job, { status: 202 });
}
