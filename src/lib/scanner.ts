import * as cheerio from "cheerio";
import { chromium, type Browser } from "playwright";

import { prisma } from "@/lib/db";

const requestTimeoutMs = 12_000;
const maxPagesPerScan = Number(process.env.SCANNER_MAX_PAGES ?? 2000);
const maxDepth = 5;
const maxExternalDepth = 2;
const crawlDelayMs = 150;
const ignoredExtensions = /\.(?:jpg|jpeg|png|gif|webp|svg|css|js|json|xml|pdf|zip|mp4|mp3|woff2?)(?:$|\?)/i;

function normalizeDomain(value: string) {
  return value.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function isCandidateDomain(domain: string, sourceDomain: string) {
  if (!domain || domain === sourceDomain || domain.endsWith(`.${sourceDomain}`)) {
    return false;
  }

  return domain.includes(".") && !domain.endsWith(".local") && !domain.endsWith(".localhost");
}

async function isDomainAvailable(domain: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(`https://rdap.org/domain/${domain}`, {
      signal: controller.signal,
      headers: { accept: "application/rdap+json, application/json" },
    });

    if (response.status === 404) return true;
    if (response.ok) return false;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeUrl(value: URL) {
  value.hash = "";
  value.search = "";
  if (value.pathname.length > 1) value.pathname = value.pathname.replace(/\/+$/, "");
  return value.toString();
}

function isCrawlablePage(url: URL) {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    !ignoredExtensions.test(url.pathname)
  );
}

function extractDomain(value: string, currentUrl: string, sourceHostname: string) {
  try {
    const cleanedValue = value.trim().replace(/^['"`]+|['"`,;]+$/g, "");
    const domainValue = /^(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(cleanedValue)
      ? `https://${cleanedValue}`
      : cleanedValue;
    const link = new URL(domainValue, currentUrl);
    if (link.protocol !== "http:" && link.protocol !== "https:") return null;
    const domain = normalizeDomain(link.hostname);
    return isCandidateDomain(domain, sourceHostname) ? { domain, link } : null;
  } catch {
    return null;
  }
}

function extractDomainsFromText(text: string, sourceHostname: string) {
  const domains = new Set<string>();
  const matches = text.match(/(?:https?:\/\/|www\.)[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s"'<>]*)?|(?<![@a-z0-9-])(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}(?![a-z0-9-])/gi) ?? [];

  for (const value of matches) {
    const result = extractDomain(value.replace(/[),.;!?]+$/, ""), "https://placeholder.invalid", sourceHostname);
    if (result) domains.add(result.domain);
  }

  return domains;
}

async function fetchPage(url: string, browser: Browser) {
  const request = async (requestUrl: string, accept: string) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      return await fetch(requestUrl, {
        signal: controller.signal,
        headers: {
          accept,
          "user-agent": "domain.bot crawler/1.0 (+https://www.crabsmedia.com)",
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  const response = await request(url, "text/html,application/xhtml+xml");
  if (response.ok && (response.headers.get("content-type") ?? "").includes("text/html")) {
    return await response.text();
  }

  if ([403, 429, 451, 500, 502, 503, 504].includes(response.status)) {
    const target = url.replace(/^https?:\/\//, "");
    const fallback = await request(`https://r.jina.ai/http://${target}`, "text/plain,text/markdown,text/html");
    if (fallback.ok) {
      const fallbackContent = await fallback.text();
      const isBlocked = /captcha|requiring captcha|access denied|just a moment/i.test(fallbackContent);
      if (!isBlocked && fallbackContent.trim().length > 200) return fallbackContent;
    }
  }

  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36",
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: requestTimeoutMs });
    await page.waitForTimeout(1000);
    return await page.content();
  } finally {
    await page.close();
  }

}

export async function scanSource(sourceSiteId: string) {
  const source = await prisma.sourceSite.findUnique({ where: { id: sourceSiteId } });

  if (!source) {
    throw new Error("Kaynak bulunamadı.");
  }

  const sourceUrl = new URL(source.url);
  const sourceHostname = normalizeDomain(sourceUrl.hostname);
  const visited = new Set<string>();
  const queued = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url: normalizeUrl(sourceUrl), depth: 0 }];
  const domains = new Set<string>();
  let pagesScanned = 0;
  const browser = await chromium.launch({ headless: true });

  while (queue.length > 0 && pagesScanned < maxPagesPerScan) {
    const current = queue.shift();
    if (!current || visited.has(current.url)) continue;
    visited.add(current.url);

    let html: string | null = null;
    try {
      html = await fetchPage(current.url, browser);
    } catch {
      // A failed page should not stop the rest of the site crawl.
    }
    pagesScanned += 1;
    if (!html) continue;

    const $ = cheerio.load(html);
    const pageLinks = new Map<string, URL>();

    $("a[href], area[href], iframe[src], frame[src], link[href], [data-url], [data-domain], [data-href]").each((_, element) => {
      const attributes = ["href", "src", "data-url", "data-domain", "data-href"];
      for (const attribute of attributes) {
        const value = $(element).attr(attribute);
        if (!value) continue;
        const result = extractDomain(value, current.url, sourceHostname);
        if (result) pageLinks.set(normalizeUrl(result.link), result.link);
      }
    });

    for (const domain of extractDomainsFromText(html, sourceHostname)) {
      domains.add(domain);
    }

    for (const [normalizedLink, link] of pageLinks) {
      const domain = normalizeDomain(link.hostname);
      domains.add(domain);

      const isSourcePage = domain === sourceHostname;
      const allowedDepth = isSourcePage ? maxDepth : maxExternalDepth;
      if (current.depth < allowedDepth && isCrawlablePage(link) && !queued.has(normalizedLink)) {
        queued.add(normalizedLink);
        queue.push({ url: normalizedLink, depth: current.depth + 1 });
      }
    }

    if (queue.length > 0) await new Promise((resolve) => setTimeout(resolve, crawlDelayMs));
  }

  const candidates = [];
  for (const domain of domains) {
    const available = await isDomainAvailable(domain);
    if (available === true) candidates.push(domain);
  }

  let created = 0;
  for (const domain of candidates) {
    const existing = await prisma.droppedDomain.findUnique({ where: { name: domain } });
    if (!existing) {
      await prisma.droppedDomain.create({ data: { name: domain, sourceSiteId: source.id, status: "DISCOVERED" } });
      created += 1;
    }
  }

  await prisma.sourceSite.update({ where: { id: source.id }, data: { lastScanned: new Date() } });
  await browser.close();

  return {
    pagesScanned,
    queuedPages: queue.length,
    linksFound: domains.size,
    candidatesFound: candidates.length,
    created,
    discoveredDomains: Array.from(domains).sort(),
    availableDomains: candidates,
    scannedUrls: Array.from(visited),
  };
}
