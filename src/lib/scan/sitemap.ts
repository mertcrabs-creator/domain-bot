import * as cheerio from "cheerio";

import { fetchRaw } from "@/lib/scan/fetcher";

const maxSitemapFiles = 50_000;
const defaultSitemapPaths = ["/sitemap_index.xml", "/sitemap.xml", "/sitemap-index.xml", "/news-sitemap.xml"];

export type SitemapUrl = { url: string; lastmod: Date | null };

function parseDate(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

async function robotsSitemaps(origin: string) {
  try {
    const { body } = await fetchRaw(`${origin}/robots.txt`, "text/plain");
    if (!body) return [];
    return body
      .split(/\r?\n/)
      .map((line) => /^\s*sitemap:\s*(\S+)/i.exec(line)?.[1])
      .filter((value): value is string => Boolean(value));
  } catch {
    return [];
  }
}

/**
 * Walks every sitemap of a site and streams the page URLs it lists to `onUrls`.
 * Child sitemaps whose lastmod is older than `since` are skipped, so re-scans only read what changed.
 */
export async function walkSitemaps(options: {
  origin: string;
  since: Date | null;
  onUrls: (urls: SitemapUrl[]) => Promise<void>;
  onProgress?: (filesRead: number, urlsFound: number) => Promise<void>;
  shouldStop?: () => Promise<boolean>;
}) {
  const roots = await robotsSitemaps(options.origin);
  const queue = roots.length > 0 ? roots : defaultSitemapPaths.map((path) => `${options.origin}${path}`);
  const seen = new Set(queue);
  let filesRead = 0;
  let urlsFound = 0;

  while (queue.length > 0 && filesRead < maxSitemapFiles) {
    const sitemapUrl = queue.shift()!;
    let body: string | null = null;
    try {
      body = (await fetchRaw(sitemapUrl, "application/xml,text/xml,*/*")).body;
    } catch {
      // A broken child sitemap should not stop the others.
    }
    filesRead += 1;
    if (!body || !/<(?:sitemapindex|urlset)[\s>]/i.test(body)) continue;

    const $ = cheerio.load(body, { xml: true });

    $("sitemap").each((_, element) => {
      const loc = $(element).children("loc").text().trim();
      const lastmod = parseDate($(element).children("lastmod").text());
      if (!loc || seen.has(loc)) return;
      if (options.since && lastmod && lastmod < options.since) return;
      seen.add(loc);
      queue.push(loc);
    });

    const urls: SitemapUrl[] = [];
    $("url").each((_, element) => {
      const loc = $(element).children("loc").text().trim();
      if (loc) urls.push({ url: loc, lastmod: parseDate($(element).children("lastmod").text()) });
    });

    if (urls.length > 0) {
      urlsFound += urls.length;
      await options.onUrls(urls);
    }
    if (filesRead % 10 === 0) {
      await options.onProgress?.(filesRead, urlsFound);
      if (await options.shouldStop?.()) break;
    }
  }

  return { filesRead, urlsFound };
}
