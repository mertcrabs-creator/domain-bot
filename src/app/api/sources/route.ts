import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { registrableDomain } from "@/lib/scan/domains";
import { candidateAvailabilities } from "@/lib/scan/rdap";

export async function GET() {
  const session = await getSession();
  if (!session?.fullAccess) return NextResponse.json({ error: "Yetkisiz erişim." }, { status: 401 });

  const sources = await prisma.sourceSite.findMany({
    orderBy: { createdAt: "desc" },
    include: { jobs: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  const candidateCounts = await Promise.all(
    sources.map((source) =>
      prisma.linkedDomain.count({
        where: { availability: { in: candidateAvailabilities }, mentions: { some: { sourceSiteId: source.id } } },
      }),
    ),
  );

  // A job still queued after this long means no worker process is picking jobs up.
  const workerMissingAfter = new Date(Date.now() - 15_000);
  return NextResponse.json(
    sources.map(({ jobs, ...source }, index) => ({
      ...source,
      latestJob: jobs[0] ? { ...jobs[0], waitingForWorker: jobs[0].status === "QUEUED" && jobs[0].createdAt < workerMissingAfter } : null,
      candidateCount: candidateCounts[index],
    })),
  );
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.fullAccess) return NextResponse.json({ error: "Yetkisiz erişim." }, { status: 401 });

  try {
    const body = (await request.json()) as { name?: string; url?: string; mode?: string };
    const name = body.name?.trim();
    const url = body.url?.trim();
    const mode = body.mode === "CRAWL" ? "CRAWL" : "SITEMAP";
    if (!name || !url) return NextResponse.json({ error: "Kaynak adı ve URL gerekli." }, { status: 400 });

    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return NextResponse.json({ error: "Yalnızca HTTP veya HTTPS URL kullanılabilir." }, { status: 400 });
    }

    if (mode === "SITEMAP") {
      // A sitemap scan covers the whole site, so a second sitemap source on the same domain would duplicate it.
      const domain = registrableDomain(parsed.hostname)?.domain;
      const sitemapSources = await prisma.sourceSite.findMany({ where: { mode: "SITEMAP" }, select: { name: true, url: true } });
      const duplicate = sitemapSources.find((source) => registrableDomain(new URL(source.url).hostname)?.domain === domain);
      if (duplicate) {
        return NextResponse.json({ error: `${domain} arşivi zaten "${duplicate.name}" kaynağıyla taranıyor.` }, { status: 409 });
      }
    }

    const source = await prisma.sourceSite.create({ data: { name, url, mode } });
    return NextResponse.json(source, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Kaynak eklenemedi.";
    return NextResponse.json({ error: message.includes("Unique constraint") ? "Bu URL zaten kayıtlı." : message }, { status: 400 });
  }
}
