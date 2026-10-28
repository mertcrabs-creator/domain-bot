import * as cheerio from "cheerio";

import { fetchRaw } from "@/lib/scan/fetcher";

// Where news sites keep their sitemaps when robots.txt does not list them (or lists only the 48h news sitemap).
// Index files come first so the archive is discovered before the small news-only files.
const defaultSitemapPaths = [
  // Generic and Yoast / Rank Math / WordPress core
  "/sitemap_index.xml",
  "/sitemap-index.xml",
  "/sitemapindex.xml",
  "/sitemap.xml",
  "/sitemap.xml.gz",
  "/wp-sitemap.xml",
  // Sitemaps kept in a folder (BBC, Guardian, Daily Sabah, many Turkish and German publishers)
  "/sitemaps/index.xml",
  "/sitemaps/sitemap.xml",
  "/sitemaps/sitemap_index.xml",
  "/sitemaps/sitemap-index.xml",
  "/sitemaps/sitemap_archive.xml",
  "/sitemap/index.xml",
  "/sitemap/sitemap.xml",
  "/sitemap/sitemap-index.xml",
  "/sitemap-archive.xml",
  // Arc Publishing (Washington Post, Reuters, many newspapers)
  "/arc/outboundfeeds/sitemap-index/?outputType=xml",
  "/arc/outboundfeeds/news-sitemap-index/?outputType=xml",
  // Google News sitemaps
  "/news-sitemap.xml",
  "/sitemap_news.xml",
  "/sitemap-news.xml",
  "/news.xml",
  "/sitemaps/news.xml",
  "/googlenews.xml",
];
// Index names tried next to a sitemap that robots.txt lists inside a folder, e.g. /sitemaps/sitemap_latest.xml.
const siblingIndexNames = ["index.xml", "sitemap.xml", "sitemap_index.xml", "sitemap-index.xml", "sitemap_archive.xml"];
const fetchConcurrency = 4;
// Child sitemaps failing in a row usually means the site started blocking us; the URLs found so far are crawled instead.
const maxConsecutiveChildFailures = 12;

export type SitemapUrl = { url: string; lastmod: Date | null };

type ParsedFile = { children: Array<{ url: string; lastmod: Date | null }>; urls: SitemapUrl[] };

function parseDate(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

function absoluteUrl(value: string, base: string) {
  try {
    const url = new URL(value.trim(), base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function robotsSitemaps(origin: string) {
  try {
    const { body } = await fetchRaw(`${origin}/robots.txt`, "text/plain");
    if (!body) return [];
    return body
      .split(/\r?\n/)
      .map((line) => /^\s*sitemap:\s*(\S+)/i.exec(line)?.[1])
      .map((value) => (value ? absoluteUrl(value, origin) : null))
      .filter((value): value is string => Boolean(value));
  } catch {
    return [];
  }
}

/**
 * `<link rel="sitemap">` declared on the home page.
 * RSS alternates are deliberately not used: a site without a sitemap is better served by the internal crawl,
 * which the worker only starts when no sitemap URL was found at all.
 */
async function homepageSitemaps(origin: string) {
  try {
    const { body, finalUrl } = await fetchRaw(`${origin}/`);
    if (!body) return [];
    const $ = cheerio.load(body);
    return $("link[rel='sitemap'][href]")
      .map((_, element) => absoluteUrl($(element).attr("href") ?? "", finalUrl))
      .get()
      .filter((value): value is string => Boolean(value));
  } catch {
    return [];
  }
}

function siblingIndexes(sitemapUrl: string) {
  const url = new URL(sitemapUrl);
  const folder = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
  if (folder === "/") return []; // The root folder is covered by the default paths.
  return siblingIndexNames.map((name) => `${url.origin}${folder}${name}`);
}

/** Reads sitemap indexes, urlsets, RSS/Atom feeds and plain-text sitemaps (one URL per line). Returns null for anything else. */
function parseSitemapFile(body: string, fileUrl: string): ParsedFile | null {
  const head = body.slice(0, 2000);

  if (/<(?:sitemapindex|urlset)[\s>]/i.test(body)) {
    const $ = cheerio.load(body, { xml: true });
    const read = (selector: string) =>
      $(selector)
        .map((_, element) => ({
          url: absoluteUrl($(element).children("loc").text(), fileUrl),
          lastmod: parseDate($(element).children("lastmod").text()),
        }))
        .get()
        .filter((entry): entry is { url: string; lastmod: Date | null } => Boolean(entry.url));
    // Some indexes put several <loc> tags in one <sitemap> (ESPN), so each <loc> is read on its own.
    const children = $("sitemap")
      .map((_, element) => {
        const lastmod = parseDate($(element).children("lastmod").text());
        return $(element)
          .children("loc")
          .map((_, loc) => ({ url: absoluteUrl($(loc).text(), fileUrl), lastmod }))
          .get();
      })
      .get()
      .filter((entry): entry is { url: string; lastmod: Date | null } => Boolean(entry.url));
    return { children, urls: read("url") };
  }

  if (/<rss[\s>]|<rdf:RDF[\s>]/i.test(head)) {
    const $ = cheerio.load(body, { xml: true });
    const urls = $("item")
      .map((_, element) => ({
        url: absoluteUrl($(element).children("link").text() || $(element).children("guid").text(), fileUrl),
        lastmod: parseDate($(element).children("pubDate").text() || $(element).children("dc\\:date").text()),
      }))
      .get()
      .filter((entry): entry is SitemapUrl => Boolean(entry.url));
    return { children: [], urls };
  }

  if (/<feed[\s>]/i.test(head)) {
    const $ = cheerio.load(body, { xml: true });
    const urls = $("entry")
      .map((_, element) => {
        const link = $(element).children("link[rel='alternate'], link:not([rel])").first().attr("href") ?? "";
        return {
          url: absoluteUrl(link, fileUrl),
          lastmod: parseDate($(element).children("updated").text() || $(element).children("published").text()),
        };
      })
      .get()
      .filter((entry): entry is SitemapUrl => Boolean(entry.url));
    return { children: [], urls };
  }

  // Plain-text sitemap: every non-empty line is an absolute URL. HTML error pages never pass this check.
  if (!head.trimStart().startsWith("<")) {
    const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const urls = lines.filter((line) => /^https?:\/\/\S+$/i.test(line));
    if (urls.length > 0 && urls.length >= lines.length * 0.9) {
      return { children: [], urls: urls.map((url) => ({ url, lastmod: null })) };
    }
  }

  return null;
}

async function fetchSitemapFile(url: string) {
  try {
    const { body, finalUrl } = await fetchRaw(url, "application/xml,text/xml,application/rss+xml,application/atom+xml,text/plain,*/*");
    return body ? parseSitemapFile(body, finalUrl) : null;
  } catch {
    // A broken or missing sitemap should not stop the others.
    return null;
  }
}

/**
 * Walks every sitemap of a site and streams the page URLs it lists to `onUrls`.
 * Sources are tried in order: robots.txt, index files next to the ones robots.txt lists, `<link rel="sitemap">`
 * and the usual sitemap paths. RSS/Atom and plain-text files are read when one of those points to them.
 * When `manualUrls` is not empty, only those files (and their children) are read and discovery is skipped.
 * Child sitemaps whose lastmod is older than `since` are skipped, so re-scans only read what changed.
 * Stops after `maxFiles` sitemap files so page crawling can start without reading huge sitemap trees,
 * and after `maxConsecutiveChildFailures` unreadable child sitemaps in a row.
 */
export async function walkSitemaps(options: {
  origin: string;
  manualUrls?: string[];
  since: Date | null;
  maxFiles: number;
  onUrls: (urls: SitemapUrl[]) => Promise<void>;
  onProgress?: (filesRead: number, urlsFound: number, filesFailed: number) => Promise<void>;
  shouldStop?: () => Promise<boolean>;
}) {
  const queue: string[] = [];
  const seen = new Set<string>();
  // Files listed by an index; unlike the guessed default paths, these are expected to exist.
  const childUrls = new Set<string>();
  const enqueue = (urls: string[]) => {
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      queue.push(url);
    }
  };
  if (options.manualUrls?.length) {
    enqueue(options.manualUrls);
  } else {
    const [robots, homepage] = await Promise.all([robotsSitemaps(options.origin), homepageSitemaps(options.origin)]);
    enqueue(robots);
    enqueue(robots.flatMap(siblingIndexes));
    enqueue(homepage);
    enqueue(defaultSitemapPaths.map((path) => `${options.origin}${path}`));
  }

  let filesRead = 0;
  let filesFailed = 0;
  let urlsFound = 0;
  let consecutiveChildFailures = 0;
  let lastReportedAt = 0;

  while (queue.length > 0 && filesRead < options.maxFiles && consecutiveChildFailures < maxConsecutiveChildFailures) {
    // Fetch a few files at once (most default paths are 404s), but handle the results in queue order.
    const batch = queue.splice(0, Math.min(fetchConcurrency, options.maxFiles - filesRead));
    const files = await Promise.all(batch.map(fetchSitemapFile));

    for (const [index, file] of files.entries()) {
      if (!file) {
        if (childUrls.has(batch[index])) {
          filesFailed += 1;
          consecutiveChildFailures += 1;
        }
        continue;
      }
      filesRead += 1;
      consecutiveChildFailures = 0;
      const children = file.children.filter((child) => !(options.since && child.lastmod && child.lastmod < options.since)).map((child) => child.url);
      for (const child of children) childUrls.add(child);
      enqueue(children);
      if (file.urls.length > 0) {
        urlsFound += file.urls.length;
        await options.onUrls(file.urls);
      }
    }

    // Report on a timer rather than per file read, so the job keeps its heartbeat while files fail or time out.
    if (Date.now() - lastReportedAt >= 10_000) {
      lastReportedAt = Date.now();
      await options.onProgress?.(filesRead, urlsFound, filesFailed);
      if (await options.shouldStop?.()) break;
    }
  }

  return {
    filesRead,
    urlsFound,
    truncated: queue.length > 0 && filesRead >= options.maxFiles,
    blocked: queue.length > 0 && consecutiveChildFailures >= maxConsecutiveChildFailures,
  };
}
