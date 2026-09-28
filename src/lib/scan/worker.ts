import type { ScanJob, SourcePage } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { registrableDomain } from "@/lib/scan/domains";
import { extractPage, isArticleLikeUrl, isCrawlableUrl, normalizePageUrl, type ExtractedMention } from "@/lib/scan/extract";
import { PageFetcher } from "@/lib/scan/fetcher";
import { candidateAvailabilities, checkDomain, nextCheckDate, RdapRateLimitError, type DomainCheck } from "@/lib/scan/rdap";
import { walkSitemaps } from "@/lib/scan/sitemap";

const pageConcurrency = Number(process.env.SCANNER_CONCURRENCY ?? 4);
const maxPagesPerJob = Number(process.env.SCANNER_MAX_PAGES ?? 0); // 0 = no limit
const rdapConcurrency = 4;
const crawlDelayMs = 300;
const maxCrawlDepth = 3;
const maxAttempts = 2;
const batchSize = 40;
// Postgres btree index rows are capped at ~2.7KB; longer URLs are never real article pages anyway.
const maxPageUrlLength = 2000;
const staleJobMs = 2 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mapWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]);
  });
  await Promise.all(lanes);
}

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// ---------------------------------------------------------------------------
// Scan jobs
// ---------------------------------------------------------------------------

async function isCancelled(jobId: string) {
  const job = await prisma.scanJob.findUnique({ where: { id: jobId }, select: { status: true } });
  return job?.status !== "RUNNING";
}

async function touchJob(jobId: string, data: Partial<Pick<ScanJob, "phase" | "lastMessage" | "pagesTotal" | "pagesDone" | "pagesFailed" | "domainsFound" | "mentionsFound">>) {
  await prisma.scanJob.updateMany({ where: { id: jobId, status: "RUNNING" }, data: { ...data, heartbeatAt: new Date() } });
}

async function refreshCounters(jobId: string, sourceSiteId: string) {
  const [pageCounts, [mentionStats]] = await Promise.all([
    prisma.sourcePage.groupBy({ by: ["status"], where: { sourceSiteId }, _count: true }),
    prisma.$queryRaw<Array<{ domains: bigint; mentions: bigint }>>`
      SELECT count(DISTINCT "linkedDomainId") AS domains, count(*) AS mentions
      FROM "DomainMention" WHERE "sourceSiteId" = ${sourceSiteId}`,
  ]);
  const count = (status: string) => pageCounts.find((row) => row.status === status)?._count ?? 0;
  await touchJob(jobId, {
    pagesTotal: count("PENDING") + count("DONE") + count("FAILED"),
    pagesDone: count("DONE"),
    pagesFailed: count("FAILED"),
    domainsFound: Number(mentionStats.domains),
    mentionsFound: Number(mentionStats.mentions),
  });
}

async function enqueuePages(
  sourceSiteId: string,
  sourceDomain: string,
  entries: Array<{ url: string; lastmod?: Date | null; depth: number }>,
  articlesOnly = false,
) {
  const data = new Map<string, { sourceSiteId: string; url: string; lastmod: Date | null; depth: number }>();
  for (const entry of entries) {
    try {
      const url = new URL(entry.url);
      if (!isCrawlableUrl(url, sourceDomain) || (articlesOnly && !isArticleLikeUrl(url))) continue;
      const normalized = normalizePageUrl(url);
      if (normalized.length > maxPageUrlLength) continue;
      data.set(normalized, { sourceSiteId, url: normalized, lastmod: entry.lastmod ?? null, depth: entry.depth });
    } catch {
      // Skip malformed URLs.
    }
  }
  const rows = [...data.values()];
  for (let index = 0; index < rows.length; index += 1000) {
    await prisma.sourcePage.createMany({ data: rows.slice(index, index + 1000), skipDuplicates: true });
  }
}

async function saveMentions(sourceSiteId: string, sourcePageId: string, mentions: ExtractedMention[]) {
  if (mentions.length === 0) return;
  const names = [...new Set(mentions.map((mention) => mention.domain))];
  await prisma.linkedDomain.createMany({ data: names.map((name) => ({ name })), skipDuplicates: true });
  const domains = await prisma.linkedDomain.findMany({ where: { name: { in: names } }, select: { id: true, name: true } });
  const idByName = new Map(domains.map((domain) => [domain.name, domain.id]));

  await prisma.domainMention.createMany({
    data: mentions.map((mention) => ({
      linkedDomainId: idByName.get(mention.domain)!,
      sourcePageId,
      sourceSiteId,
      targetUrl: mention.targetUrl,
      anchorText: mention.anchorText,
      rel: mention.rel,
    })),
    skipDuplicates: true,
  });

  const ids = [...idByName.values()];
  await prisma.$executeRaw`
    UPDATE "LinkedDomain" SET "mentionCount" = (
      SELECT count(*) FROM "DomainMention" m WHERE m."linkedDomainId" = "LinkedDomain"."id"
    ) WHERE "id" = ANY(${ids})`;
}

async function processPage(page: SourcePage, sourceDomain: string, crawlInternal: boolean, fetcher: PageFetcher) {
  let result: Awaited<ReturnType<PageFetcher["fetchHtml"]>> | null = null;
  try {
    result = await fetcher.fetchHtml(page.url);
  } catch {
    // Treated as a failed attempt below.
  }

  if (!result?.body) {
    const gone = result?.status === 404 || result?.status === 410;
    await prisma.sourcePage.update({
      where: { id: page.id },
      data: { attempts: { increment: 1 }, fetchedAt: new Date(), status: gone || page.attempts + 1 >= maxAttempts ? "FAILED" : "PENDING" },
    });
    return;
  }

  const extracted = extractPage(result.body, result.finalUrl, sourceDomain);
  await saveMentions(page.sourceSiteId, page.id, extracted.mentions);

  if (crawlInternal && page.depth < maxCrawlDepth) {
    await enqueuePages(page.sourceSiteId, sourceDomain, extracted.internalLinks.map((url) => ({ url, depth: page.depth + 1 })));
  }

  await prisma.sourcePage.update({
    where: { id: page.id },
    data: { status: "DONE", attempts: { increment: 1 }, fetchedAt: new Date(), publishedAt: extracted.publishedAt },
  });
}

async function runJob(job: ScanJob) {
  const source = await prisma.sourceSite.findUniqueOrThrow({ where: { id: job.sourceSiteId } });
  const sourceUrl = new URL(source.url);
  const sourceDomain = registrableDomain(sourceUrl.hostname)?.domain ?? sourceUrl.hostname;
  const fetcher = new PageFetcher();
  log(`Job ${job.id} started for ${source.name} (${source.mode})`);

  try {
    let crawlInternal = source.mode === "CRAWL";

    if (source.mode === "SITEMAP") {
      await touchJob(job.id, { phase: "discovering", lastMessage: "Sitemap'ler okunuyor..." });
      const { filesRead, urlsFound } = await walkSitemaps({
        origin: sourceUrl.origin,
        since: source.lastScanned,
        onUrls: (urls) => enqueuePages(source.id, sourceDomain, urls.map((entry) => ({ ...entry, depth: 0 })), true),
        onProgress: (files, urls) => touchJob(job.id, { lastMessage: `${files} sitemap dosyası okundu, ${urls} URL bulundu` }),
        shouldStop: () => isCancelled(job.id),
      });
      log(`Job ${job.id}: ${filesRead} sitemap files, ${urlsFound} URLs`);
      if (urlsFound === 0 && (await prisma.sourcePage.count({ where: { sourceSiteId: source.id } })) === 0) {
        crawlInternal = true;
        await touchJob(job.id, { lastMessage: "Sitemap bulunamadı, site içi taramaya geçildi" });
      }
    }

    if (crawlInternal) {
      await enqueuePages(source.id, sourceDomain, [{ url: source.url, depth: 0 }]);
      await prisma.sourcePage.updateMany({ where: { sourceSiteId: source.id, url: normalizePageUrl(sourceUrl) }, data: { status: "PENDING", attempts: 0 } });
    }

    await touchJob(job.id, { phase: "crawling", lastMessage: "Sayfalar taranıyor..." });
    await refreshCounters(job.id, source.id);

    let processed = 0;
    while (!maxPagesPerJob || processed < maxPagesPerJob) {
      if (await isCancelled(job.id)) return;
      const pages = await prisma.sourcePage.findMany({
        where: { sourceSiteId: source.id, status: "PENDING" },
        orderBy: [{ lastmod: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
        take: batchSize,
      });
      if (pages.length === 0) break;

      await mapWithConcurrency(pages, pageConcurrency, async (page) => {
        await processPage(page, sourceDomain, crawlInternal, fetcher);
        await sleep(crawlDelayMs);
      });
      processed += pages.length;
      await refreshCounters(job.id, source.id);
    }
    await fetcher.close();

    // Registry lookups are done by the shared checker loop; wait for this source's domains.
    await touchJob(job.id, { phase: "checking" });
    while (!(await isCancelled(job.id))) {
      const remaining = await prisma.linkedDomain.count({ where: { availability: "UNCHECKED", mentions: { some: { sourceSiteId: source.id } } } });
      if (remaining === 0) break;
      await touchJob(job.id, { lastMessage: `${remaining} domain kontrol bekliyor` });
      await sleep(5000);
    }

    const pending = await prisma.sourcePage.count({ where: { sourceSiteId: source.id, status: "PENDING" } });
    await prisma.sourceSite.update({ where: { id: source.id }, data: { lastScanned: new Date() } });
    await prisma.scanJob.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: {
        status: "COMPLETED",
        phase: "done",
        finishedAt: new Date(),
        lastMessage: pending > 0 ? `Sayfa limiti doldu, ${pending} sayfa sonraki taramaya kaldı` : "Tarama tamamlandı",
      },
    });
    log(`Job ${job.id} completed`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Job ${job.id} failed: ${message}`);
    await prisma.scanJob.update({ where: { id: job.id }, data: { status: "FAILED", error: message, finishedAt: new Date() } });
  } finally {
    await fetcher.close();
  }
}

async function claimNextJob() {
  const job = await prisma.scanJob.findFirst({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" } });
  if (!job) return null;
  const claimed = await prisma.scanJob.updateMany({
    where: { id: job.id, status: "QUEUED" },
    data: { status: "RUNNING", startedAt: job.startedAt ?? new Date(), heartbeatAt: new Date(), error: null },
  });
  return claimed.count === 1 ? job : null;
}

/** A single worker is assumed: on startup every RUNNING job was interrupted; later only stale ones are. */
async function requeueInterruptedJobs(onlyStale: boolean) {
  const { count } = await prisma.scanJob.updateMany({
    where: onlyStale
      ? { status: "RUNNING", OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: new Date(Date.now() - staleJobMs) } }] }
      : { status: "RUNNING" },
    data: { status: "QUEUED", lastMessage: "Worker yeniden başladı, kaldığı yerden devam edecek" },
  });
  if (count > 0) log(`Requeued ${count} interrupted job(s)`);
}

// ---------------------------------------------------------------------------
// Registry checks
// ---------------------------------------------------------------------------

async function applyCheck(domain: { id: string; name: string }, check: DomainCheck) {
  await prisma.linkedDomain.update({
    where: { id: domain.id },
    data: {
      availability: check.availability,
      rdapStatuses: check.statuses,
      registeredAt: check.registeredAt,
      expiresAt: check.expiresAt,
      registrar: check.registrar,
      checkedAt: new Date(),
      nextCheckAt: nextCheckDate(check.availability),
      checkError: null,
    },
  });

  if (!candidateAvailabilities.includes(check.availability)) return;
  const firstMention = await prisma.domainMention.findFirst({
    where: { linkedDomainId: domain.id },
    orderBy: { createdAt: "asc" },
    select: { sourceSiteId: true },
  });
  if (!firstMention) return;
  await prisma.droppedDomain.upsert({
    where: { name: domain.name },
    create: { name: domain.name, linkedDomainId: domain.id, sourceSiteId: firstMention.sourceSiteId, expiresAt: check.expiresAt },
    update: { linkedDomainId: domain.id, expiresAt: check.expiresAt },
  });
}

/** Checks a batch of due domains. Returns how many were processed. */
async function runDomainChecks() {
  const due = await prisma.linkedDomain.findMany({
    where: { nextCheckAt: { lte: new Date() } },
    orderBy: [{ checkedAt: { sort: "asc", nulls: "first" } }, { mentionCount: "desc" }],
    take: 40,
    select: { id: true, name: true, availability: true },
  });

  await mapWithConcurrency(due, rdapConcurrency, async (domain) => {
    try {
      await applyCheck(domain, await checkDomain(domain.name));
    } catch (error) {
      if (error instanceof RdapRateLimitError) throw error;
      await prisma.linkedDomain.update({
        where: { id: domain.id },
        data: {
          availability: domain.availability === "UNCHECKED" ? "UNKNOWN" : domain.availability,
          checkError: error instanceof Error ? error.message : String(error),
          checkedAt: new Date(),
          nextCheckAt: nextCheckDate("UNKNOWN"),
        },
      });
    }
    await sleep(150);
  });
  return due.length;
}

async function checkerLoop() {
  while (true) {
    try {
      const processed = await runDomainChecks();
      if (processed === 0) await sleep(5000);
    } catch (error) {
      if (error instanceof RdapRateLimitError) {
        log("RDAP rate limit hit, pausing checks for 60s");
        await sleep(60_000);
      } else {
        log(`Domain check loop error: ${error instanceof Error ? error.message : error}`);
        await sleep(10_000);
      }
    }
  }
}

export async function startWorker() {
  log("domain.bot worker started");
  await requeueInterruptedJobs(false);
  void checkerLoop();

  while (true) {
    try {
      const job = await claimNextJob();
      if (job) {
        await runJob(job);
      } else {
        await requeueInterruptedJobs(true);
        await sleep(3000);
      }
    } catch (error) {
      log(`Job loop error: ${error instanceof Error ? error.message : error}`);
      await sleep(10_000);
    }
  }
}
