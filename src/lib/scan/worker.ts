import { Prisma, type ScanJob, type SourcePage } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { registrableDomain } from "@/lib/scan/domains";
import { extractPage, isArticleLikeUrl, isCrawlableUrl, normalizePageUrl, type ExtractedMention } from "@/lib/scan/extract";
import { PageFetcher } from "@/lib/scan/fetcher";
import { candidateAvailabilities, checkDomain, nextCheckDate, RdapRateLimitError, type DomainCheck } from "@/lib/scan/rdap";
import { walkSitemaps } from "@/lib/scan/sitemap";

const jobConcurrency = Math.max(1, Number(process.env.SCANNER_JOB_CONCURRENCY ?? 3));
const pageConcurrency = Math.max(1, Number(process.env.SCANNER_CONCURRENCY ?? 8));
const maxPagesPerJob = Number(process.env.SCANNER_MAX_PAGES ?? 0); // 0 = no limit
const maxSitemapFiles = Number(process.env.SCANNER_MAX_SITEMAPS ?? 100);
const pagesPerBatch = 50_000;
const crawlDelayMs = Number(process.env.SCANNER_DELAY_MS ?? 100); // per lane, between two pages
const rdapConcurrency = 6;
const maxCrawlDepth = 3;
const maxAttempts = 2;
// Pages are read from the DB in chunks and their results written back in batches, so the DB sees a few queries per batch, not per page.
const pageChunkSize = 200;
const flushSize = 50;
const flushIntervalMs = 10_000;
const fullCountersIntervalMs = 2 * 60 * 1000;
// Postgres btree index rows are capped at ~2.7KB; longer URLs are never real article pages anyway.
const maxPageUrlLength = 2000;
const staleJobMs = 2 * 60 * 1000;
const staleCheckIntervalMs = 60_000;
const idleJobPollMs = 5000;
const idleCheckerPollMs = 30_000;
const idleDeletionPollMs = 15_000;

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

type JobCounters = Pick<ScanJob, "pagesTotal" | "pagesDone" | "pagesFailed" | "domainsFound" | "mentionsFound">;

async function isCancelled(jobId: string) {
  const job = await prisma.scanJob.findUnique({ where: { id: jobId }, select: { status: true } });
  return job?.status !== "RUNNING";
}

/** Updates a running job and its heartbeat. Returns false when the job is no longer running (cancelled or requeued). */
async function touchJob(jobId: string, data: Partial<Pick<ScanJob, "phase" | "lastMessage"> & JobCounters>) {
  const { count } = await prisma.scanJob.updateMany({ where: { id: jobId, status: "RUNNING" }, data: { ...data, heartbeatAt: new Date() } });
  return count === 1;
}

/** Exact counters of one batch of pages; costly on big batches, so only run at the start, at the end and every few minutes. */
async function countJob(sourceSiteId: string, batch: number): Promise<JobCounters> {
  const [pageCounts, [mentionStats]] = await Promise.all([
    prisma.sourcePage.groupBy({ by: ["status"], where: { sourceSiteId, batch }, _count: true }),
    prisma.$queryRaw<Array<{ domains: bigint; mentions: bigint }>>`
      SELECT count(DISTINCT m."linkedDomainId") AS domains, count(*) AS mentions
      FROM "DomainMention" m JOIN "SourcePage" p ON p."id" = m."sourcePageId"
      WHERE p."sourceSiteId" = ${sourceSiteId} AND p."batch" = ${batch}`,
  ]);
  const count = (status: string) => pageCounts.find((row) => row.status === status)?._count ?? 0;
  return {
    pagesTotal: count("PENDING") + count("DONE") + count("FAILED"),
    pagesDone: count("DONE"),
    pagesFailed: count("FAILED"),
    domainsFound: Number(mentionStats.domains),
    mentionsFound: Number(mentionStats.mentions),
  };
}

/** Rewrites the PageBatch counters of a source (or of one of its batches) from its pages. */
async function syncBatches(sourceSiteId: string, batch?: number) {
  const onlyBatch = batch === undefined ? Prisma.empty : Prisma.sql`AND "batch" = ${batch}`;
  await prisma.$executeRaw`
    INSERT INTO "PageBatch" ("id", "sourceSiteId", "number", "pagesTotal", "pagesDone", "pagesFailed")
    SELECT gen_random_uuid()::text, "sourceSiteId", "batch", count(*), count(*) FILTER (WHERE "status" = 'DONE'), count(*) FILTER (WHERE "status" = 'FAILED')
    FROM "SourcePage" WHERE "sourceSiteId" = ${sourceSiteId} AND "batch" > 0 ${onlyBatch}
    GROUP BY "sourceSiteId", "batch"
    ON CONFLICT ("sourceSiteId", "number") DO UPDATE SET
      "pagesTotal" = EXCLUDED."pagesTotal", "pagesDone" = EXCLUDED."pagesDone", "pagesFailed" = EXCLUDED."pagesFailed"`;
}

/**
 * Splits the pages that are in no batch yet into new batches of `pagesPerBatch`, oldest articles first.
 * Earlier batches are left as they are, so a re-scan only adds batches for the newly found pages.
 */
async function assignBatches(sourceSiteId: string) {
  await prisma.$executeRaw`
    UPDATE "SourcePage" p SET "batch" = v.batch
    FROM (
      SELECT "id",
        (row_number() OVER (ORDER BY "lastmod" ASC NULLS LAST, "createdAt", "id") - 1) / ${pagesPerBatch}::int + 1
          + (SELECT COALESCE(max("batch"), 0) FROM "SourcePage" WHERE "sourceSiteId" = ${sourceSiteId}) AS batch
      FROM "SourcePage" WHERE "sourceSiteId" = ${sourceSiteId} AND "batch" = 0
    ) v
    WHERE p."id" = v."id"`;
  await syncBatches(sourceSiteId);
}

/** Inserts new pages and returns how many were actually new. */
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
  let added = 0;
  for (let index = 0; index < rows.length; index += 1000) {
    added += (await prisma.sourcePage.createMany({ data: rows.slice(index, index + 1000), skipDuplicates: true })).count;
  }
  return added;
}

/** Saves the mentions of many pages at once. Returns how many mentions were new. */
async function saveMentions(sourceSiteId: string, mentions: Array<ExtractedMention & { sourcePageId: string }>) {
  if (mentions.length === 0) return 0;
  const names = [...new Set(mentions.map((mention) => mention.domain))];
  await prisma.linkedDomain.createMany({ data: names.map((name) => ({ name })), skipDuplicates: true });
  const domains = await prisma.linkedDomain.findMany({ where: { name: { in: names } }, select: { id: true, name: true } });
  const idByName = new Map(domains.map((domain) => [domain.name, domain.id]));

  const created = await prisma.domainMention.createManyAndReturn({
    data: mentions.map((mention) => ({
      linkedDomainId: idByName.get(mention.domain)!,
      sourcePageId: mention.sourcePageId,
      sourceSiteId,
      targetUrl: mention.targetUrl,
      anchorText: mention.anchorText,
      rel: mention.rel,
    })),
    skipDuplicates: true,
    select: { linkedDomainId: true },
  });

  // Counts are bumped by what was really inserted instead of re-counting every domain's mentions.
  const added = new Map<string, number>();
  for (const { linkedDomainId } of created) added.set(linkedDomainId, (added.get(linkedDomainId) ?? 0) + 1);
  if (added.size > 0) {
    await prisma.$executeRaw`
      UPDATE "LinkedDomain" d SET "mentionCount" = d."mentionCount" + v.n
      FROM unnest(${[...added.keys()]}::text[], ${[...added.values()]}::int[]) AS v(id, n)
      WHERE d."id" = v.id`;
  }
  return created.length;
}

async function refreshMentionCounts(ids: string[]) {
  await prisma.$executeRaw`
    UPDATE "LinkedDomain" SET "mentionCount" = (
      SELECT count(*) FROM "DomainMention" m WHERE m."linkedDomainId" = "LinkedDomain"."id"
    ) WHERE "id" = ANY(${ids})`;
}

type PageResult = {
  page: SourcePage;
  status: "DONE" | "PENDING" | "FAILED";
  publishedAt: Date | null;
  mentions: ExtractedMention[];
  internalLinks: string[];
};

/** Downloads and parses one page without touching the DB; the result is written later in a batch. */
async function fetchPage(page: SourcePage, sourceDomain: string, fetcher: PageFetcher): Promise<PageResult> {
  let result: Awaited<ReturnType<PageFetcher["fetchHtml"]>> | null = null;
  try {
    result = await fetcher.fetchHtml(page.url);
  } catch {
    // Treated as a failed attempt below.
  }

  if (!result?.body) {
    const gone = result?.status === 404 || result?.status === 410;
    const status = gone || page.attempts + 1 >= maxAttempts ? "FAILED" : "PENDING";
    return { page, status, publishedAt: null, mentions: [], internalLinks: [] };
  }

  try {
    const extracted = extractPage(result.body, result.finalUrl, sourceDomain);
    return { page, status: "DONE", publishedAt: extracted.publishedAt, mentions: extracted.mentions, internalLinks: extracted.internalLinks };
  } catch {
    return { page, status: "FAILED", publishedAt: null, mentions: [], internalLinks: [] };
  }
}

/**
 * Crawls the PENDING pages of one batch of a source (0 = pages in no batch) with `pageConcurrency` independent lanes.
 * Lanes never wait for each other (a slow page holds up only its own lane); pages are read from the DB
 * in chunks and results are written back in batches of `flushSize`.
 * Returns false when the job was cancelled or taken away meanwhile.
 */
async function crawlPages(job: ScanJob, sourceId: string, batch: number, sourceDomain: string, crawlInternal: boolean, fetcher: PageFetcher) {
  const counters = await countJob(sourceId, batch);
  let countersAt = Date.now();
  const refreshCounters = async () => {
    Object.assign(counters, await countJob(sourceId, batch));
    if (batch > 0) await syncBatches(sourceId, batch);
    countersAt = Date.now();
  };
  if (!(await touchJob(job.id, { phase: "crawling", lastMessage: "Sayfalar taranıyor...", ...counters }))) return false;

  const buffer: SourcePage[] = [];
  // Taken from the DB but not written back yet; excluded from the next chunk so no page is fetched twice at once.
  const inFlight = new Set<string>();
  let results: PageResult[] = [];
  let lastFlushAt = Date.now();
  let flushChain: Promise<void> = Promise.resolve();
  let refilling: Promise<void> | null = null;
  let exhausted = false;
  let stopped = false;
  let processed = 0;

  const refill = async () => {
    const pages = await prisma.sourcePage.findMany({
      where: { sourceSiteId: sourceId, batch, status: "PENDING", ...(inFlight.size > 0 ? { id: { notIn: [...inFlight] } } : {}) },
      orderBy: [{ lastmod: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
      take: pageChunkSize,
    });
    if (pages.length === 0) exhausted = true;
    for (const page of pages) inFlight.add(page.id);
    buffer.push(...pages);
  };

  const nextPage = async () => {
    while (buffer.length === 0 && !exhausted && !stopped) {
      refilling ??= refill().finally(() => (refilling = null));
      await refilling;
    }
    return stopped ? undefined : buffer.shift();
  };

  const writeBatch = async (batch: PageResult[]) => {
    const mentions = batch.flatMap((result) => result.mentions.map((mention) => ({ ...mention, sourcePageId: result.page.id })));
    const newMentions = await saveMentions(sourceId, mentions);

    let newPages = 0;
    if (crawlInternal) {
      const links = batch
        .filter((result) => result.page.depth < maxCrawlDepth)
        .flatMap((result) => result.internalLinks.map((url) => ({ url, depth: result.page.depth + 1 })));
      newPages = await enqueuePages(sourceId, sourceDomain, links);
      if (newPages > 0) exhausted = false;
    }

    // One statement for the whole batch instead of an UPDATE per page.
    await prisma.$executeRaw`
      UPDATE "SourcePage" p SET
        "status" = v.status::"SourcePageStatus",
        "attempts" = p."attempts" + 1,
        "fetchedAt" = ${new Date()},
        "publishedAt" = COALESCE(NULLIF(v.published, '')::timestamp(3), p."publishedAt")
      FROM unnest(
        ${batch.map((result) => result.page.id)}::text[],
        ${batch.map((result) => result.status)}::text[],
        ${batch.map((result) => result.publishedAt?.toISOString() ?? "")}::text[]
      ) AS v(id, status, published)
      WHERE p."id" = v.id`;
    for (const result of batch) inFlight.delete(result.page.id);

    if (Date.now() - countersAt >= fullCountersIntervalMs) {
      await refreshCounters();
    } else {
      counters.pagesTotal += newPages;
      counters.pagesDone += batch.filter((result) => result.status === "DONE").length;
      counters.pagesFailed += batch.filter((result) => result.status === "FAILED").length;
      counters.mentionsFound += newMentions;
    }
    // The heartbeat write doubles as the cancellation check.
    if (!(await touchJob(job.id, counters))) stopped = true;
  };

  const flush = () => {
    if (results.length === 0) return flushChain;
    const batch = results;
    results = [];
    lastFlushAt = Date.now();
    flushChain = flushChain.then(() => writeBatch(batch));
    return flushChain;
  };

  const lane = async () => {
    while (!stopped && (!maxPagesPerJob || processed < maxPagesPerJob)) {
      const page = await nextPage();
      if (!page) return;
      processed += 1;
      results.push(await fetchPage(page, sourceDomain, fetcher));
      if (results.length >= flushSize || Date.now() - lastFlushAt >= flushIntervalMs) await flush();
      if (crawlDelayMs > 0) await sleep(crawlDelayMs);
    }
  };

  // Lanes stop once no PENDING page is left; retried pages and newly found links bring them back for another round.
  while (!stopped && (!maxPagesPerJob || processed < maxPagesPerJob)) {
    exhausted = false;
    const before = processed;
    await Promise.all(Array.from({ length: pageConcurrency }, () => lane()));
    await flush();
    if (processed === before) break;
  }
  await flushChain;
  if (stopped) {
    if (batch > 0) await syncBatches(sourceId, batch);
    return false;
  }

  await refreshCounters();
  return touchJob(job.id, counters);
}

async function runJob(job: ScanJob) {
  const source = await prisma.sourceSite.findUniqueOrThrow({ where: { id: job.sourceSiteId } });
  const sourceUrl = new URL(source.url);
  const sourceDomain = registrableDomain(sourceUrl.hostname)?.domain ?? sourceUrl.hostname;
  const fetcher = new PageFetcher();
  log(`Job ${job.id} started for ${source.name} (${job.batch !== null ? `batch ${job.batch}` : source.mode})`);

  try {
    let crawlInternal = source.mode === "CRAWL";

    if (job.batch === null && source.mode === "SITEMAP") {
      await touchJob(job.id, { phase: "discovering", lastMessage: "Sitemap'ler okunuyor..." });
      const { filesRead, urlsFound, truncated, blocked } = await walkSitemaps({
        origin: sourceUrl.origin,
        manualUrls: source.sitemapUrls,
        since: source.lastScanned,
        maxFiles: maxSitemapFiles,
        onUrls: async (urls) => {
          await enqueuePages(source.id, sourceDomain, urls.map((entry) => ({ ...entry, depth: 0 })), true);
        },
        onProgress: async (files, urls, failed) => {
          await touchJob(job.id, { lastMessage: `${files} sitemap dosyası okundu, ${urls} URL bulundu${failed ? `, ${failed} dosya okunamadı` : ""}` });
        },
        shouldStop: () => isCancelled(job.id),
      });
      log(`Job ${job.id}: ${filesRead} sitemap files, ${urlsFound} URLs${truncated ? " (sitemap limit reached)" : ""}${blocked ? " (child sitemaps failing)" : ""}`);
      if (truncated) await touchJob(job.id, { lastMessage: `${maxSitemapFiles} sitemap limitine ulaşıldı, URL taramasına geçiliyor` });
      if (blocked) await touchJob(job.id, { lastMessage: "Sitemap dosyaları art arda okunamadı (site engelliyor olabilir), bulunan URL'lerle taramaya geçiliyor" });
      if (urlsFound === 0 && (await prisma.sourcePage.count({ where: { sourceSiteId: source.id } })) === 0) {
        crawlInternal = true;
        await touchJob(job.id, {
          lastMessage: source.sitemapUrls.length > 0 ? "Girilen sitemap'lerden URL okunamadı, site içi taramaya geçildi" : "Sitemap bulunamadı, site içi taramaya geçildi",
        });
      } else {
        // Sitemap pages are not crawled here: they are split into batches that the user starts one by one.
        await touchJob(job.id, { phase: "splitting", lastMessage: "URL'ler parçalara bölünüyor..." });
        await assignBatches(source.id);
        const batches = await prisma.pageBatch.findMany({ where: { sourceSiteId: source.id }, select: { pagesTotal: true, pagesDone: true, pagesFailed: true } });
        const sum = (key: "pagesTotal" | "pagesDone" | "pagesFailed") => batches.reduce((total, item) => total + item[key], 0);
        await prisma.sourceSite.update({ where: { id: source.id }, data: { lastScanned: new Date() } });
        await prisma.scanJob.updateMany({
          where: { id: job.id, status: "RUNNING" },
          data: {
            status: "COMPLETED",
            phase: "done",
            finishedAt: new Date(),
            pagesTotal: sum("pagesTotal"),
            pagesDone: sum("pagesDone"),
            pagesFailed: sum("pagesFailed"),
            lastMessage: `${sum("pagesTotal").toLocaleString("tr-TR")} URL, ${batches.length} parçaya bölündü. Parçaları aşağıdan tek tek başlatın.`,
          },
        });
        log(`Job ${job.id}: split into ${batches.length} batches`);
        return;
      }
    }

    if (crawlInternal) {
      await enqueuePages(source.id, sourceDomain, [{ url: source.url, depth: 0 }]);
      await prisma.sourcePage.updateMany({ where: { sourceSiteId: source.id, url: normalizePageUrl(sourceUrl) }, data: { status: "PENDING", attempts: 0 } });
    }

    const batch = job.batch ?? 0;
    if (!(await crawlPages(job, source.id, batch, sourceDomain, crawlInternal && batch === 0, fetcher))) return;
    await fetcher.close();

    // Registry lookups are done by the shared checker loop; wait for this source's domains.
    await touchJob(job.id, { phase: "checking" });
    while (true) {
      const [{ remaining }] = await prisma.$queryRaw<Array<{ remaining: bigint }>>`
        SELECT count(DISTINCT d."id") AS remaining FROM "LinkedDomain" d
        JOIN "DomainMention" m ON m."linkedDomainId" = d."id"
        WHERE d."availability" = 'UNCHECKED' AND m."sourceSiteId" = ${source.id}`;
      if (Number(remaining) === 0) break;
      if (!(await touchJob(job.id, { lastMessage: `${remaining} domain kontrol bekliyor` }))) return;
      await sleep(15_000);
    }

    const pending = await prisma.sourcePage.count({ where: { sourceSiteId: source.id, batch, status: "PENDING" } });
    // A batch crawl does not re-read the sitemaps, so it must not move the "changed since" mark of the next sitemap read.
    if (job.batch === null) await prisma.sourceSite.update({ where: { id: source.id }, data: { lastScanned: new Date() } });
    const done = job.batch !== null ? `Parça ${job.batch} tamamlandı` : "Tarama tamamlandı";
    await prisma.scanJob.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: {
        status: "COMPLETED",
        phase: "done",
        finishedAt: new Date(),
        lastMessage: pending > 0 ? `Sayfa limiti doldu, ${pending} sayfa sonraki taramaya kaldı` : done,
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

// Jobs this process is working on right now; never requeued as stale, even if a slow step delays their heartbeat.
const activeJobIds = new Set<string>();

/** A single worker process is assumed: on startup every RUNNING job was interrupted; later only stale ones are. */
async function requeueInterruptedJobs(onlyStale: boolean) {
  const { count } = await prisma.scanJob.updateMany({
    where: onlyStale
      ? {
          status: "RUNNING",
          id: { notIn: [...activeJobIds] },
          OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: new Date(Date.now() - staleJobMs) } }],
        }
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
      nextCheckAt: nextCheckDate(check.availability, check.expiresAt),
      checkError: null,
    },
  });

  if (!candidateAvailabilities.includes(check.availability)) {
    // Renewed past the expiry window: drop it from the candidate list unless someone already started working on it.
    await prisma.droppedDomain.deleteMany({ where: { linkedDomainId: domain.id, status: "DISCOVERED", assignment: null } });
    return;
  }
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
  // Ordered by the indexed column only, so picking the next batch never sorts the whole due set.
  const due = await prisma.linkedDomain.findMany({
    where: { nextCheckAt: { lte: new Date() } },
    orderBy: { nextCheckAt: "asc" },
    take: 60,
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
    await sleep(100);
  });
  return due.length;
}

async function checkerLoop() {
  while (true) {
    try {
      const processed = await runDomainChecks();
      if (processed === 0) await sleep(idleCheckerPollMs);
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

// ---------------------------------------------------------------------------
// Source deletion
// ---------------------------------------------------------------------------

const deleteBatchSize = 2000;

/** Deletes one source marked inactive by the API, in small batches so no statement runs long or holds locks for long. */
async function deleteNextSource() {
  const source = await prisma.sourceSite.findFirst({ where: { isActive: false }, select: { id: true, name: true } });
  if (!source) return false;
  log(`Deleting source ${source.name}`);

  while (true) {
    const removed = await prisma.$queryRaw<Array<{ linkedDomainId: string }>>`
      DELETE FROM "DomainMention" WHERE "id" IN (
        SELECT "id" FROM "DomainMention" WHERE "sourceSiteId" = ${source.id} LIMIT ${deleteBatchSize}
      ) RETURNING "linkedDomainId"`;
    if (removed.length === 0) break;
    await refreshMentionCounts([...new Set(removed.map((row) => row.linkedDomainId))]);
  }
  while (
    (await prisma.$executeRaw`
      DELETE FROM "SourcePage" WHERE "id" IN (
        SELECT "id" FROM "SourcePage" WHERE "sourceSiteId" = ${source.id} LIMIT ${deleteBatchSize}
      )`) > 0
  ) {
    // Keep going until the source has no pages left.
  }
  // Jobs and dropped domains are few; the cascade handles them.
  await prisma.sourceSite.deleteMany({ where: { id: source.id } });
  log(`Deleted source ${source.name}`);
  return true;
}

async function deletionLoop() {
  while (true) {
    try {
      if (!(await deleteNextSource())) await sleep(idleDeletionPollMs);
    } catch (error) {
      log(`Source deletion error: ${error instanceof Error ? error.message : error}`);
      await sleep(10_000);
    }
  }
}

// Ends the dispatcher's idle wait early when a job finishes, so the next queued job starts right away.
let wakeDispatcher: (() => void) | null = null;

/** Single dispatcher: keeps up to `jobConcurrency` jobs running and polls the queue only while a slot is free. */
async function jobLoop() {
  let lastStaleCheck = 0;
  while (true) {
    try {
      if (activeJobIds.size < jobConcurrency) {
        const job = await claimNextJob();
        if (job) {
          activeJobIds.add(job.id);
          void runJob(job)
            .catch((error) => log(`Job ${job.id} crashed: ${error instanceof Error ? error.message : error}`))
            .finally(() => {
              activeJobIds.delete(job.id);
              wakeDispatcher?.();
            });
          continue;
        }
      }
      if (Date.now() - lastStaleCheck >= staleCheckIntervalMs) {
        lastStaleCheck = Date.now();
        await requeueInterruptedJobs(true);
      }
    } catch (error) {
      log(`Job loop error: ${error instanceof Error ? error.message : error}`);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, idleJobPollMs);
      wakeDispatcher = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wakeDispatcher = null;
  }
}

export async function startWorker() {
  // A stray rejection (e.g. a dropped DB connection inside a callback) must not take the whole worker down.
  process.on("unhandledRejection", (reason) => log(`Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`));

  log(`domain.bot worker started (${jobConcurrency} parallel scans, ${pageConcurrency} pages each)`);
  while (true) {
    try {
      await requeueInterruptedJobs(false);
      break;
    } catch (error) {
      log(`Startup error, retrying in 10s: ${error instanceof Error ? error.message : error}`);
      await sleep(10_000);
    }
  }
  void checkerLoop();
  void deletionLoop();
  await jobLoop();
}
