import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseManualSitemaps } from "@/lib/scan/manual-sitemaps";

/** Updates the hand-entered sitemap URLs of a source. */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.fullAccess) return NextResponse.json({ error: "Yetkisiz erişim." }, { status: 401 });

  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { sitemapUrls?: unknown } | null;
  const sitemaps = parseManualSitemaps(body?.sitemapUrls);
  if ("error" in sitemaps) return NextResponse.json({ error: sitemaps.error }, { status: 400 });

  const source = await prisma.sourceSite.findUnique({ where: { id }, select: { isActive: true, sitemapUrls: true } });
  if (!source?.isActive) return NextResponse.json({ error: "Kaynak bulunamadı." }, { status: 404 });

  const changed = sitemaps.urls.join("\n") !== source.sitemapUrls.join("\n");
  const updated = await prisma.sourceSite.update({
    where: { id },
    // New sitemaps must be read in full, so the `since` filter of the next scan is reset.
    data: { sitemapUrls: sitemaps.urls, ...(changed ? { lastScanned: null } : {}) },
  });
  return NextResponse.json(updated);
}

// Only marks the source for deletion; the worker removes its pages and links in small batches,
// because deleting a large source in one statement easily outlives the request timeout.
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.fullAccess) return NextResponse.json({ error: "Yetkisiz erişim." }, { status: 401 });

  const { id } = await context.params;
  const assigned = await prisma.domainAssignment.count({ where: { domain: { sourceSiteId: id } } });
  if (assigned > 0) return NextResponse.json({ error: "Bu kaynaktan müşteriye atanmış domainler var, silinemez." }, { status: 409 });

  // Stop a running scan first, otherwise the worker keeps writing pages while they are being deleted.
  await prisma.scanJob.updateMany({ where: { sourceSiteId: id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", finishedAt: new Date() } });
  // updateMany is a no-op when the source is already gone (double click, two tabs).
  await prisma.sourceSite.updateMany({ where: { id }, data: { isActive: false } });
  return new NextResponse(null, { status: 202 });
}
