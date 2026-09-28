import * as cheerio from "cheerio";

import { candidateDomain, registrableDomain } from "@/lib/scan/domains";

// Ordered from most to least specific; the first selector that matches is treated as the article body.
const articleBodySelectors = [
  "[itemprop='articleBody']",
  "section[name='articleBody']",
  ".article-body",
  ".article__body",
  ".articleBody",
  ".story-body",
  ".entry-content",
  ".post-content",
  ".c-entry-content",
  "article",
  "main",
];
const boilerplateSelectors = "nav, header, footer, aside, form, script, style, noscript, [role='navigation'], [role='complementary'], .related, .newsletter, .share, .social, .byline, .ad, .advertisement";
const ignoredExtensions = /\.(?:jpe?g|png|gif|webp|svg|ico|css|js|json|xml|pdf|zip|gz|mp4|mp3|webm|woff2?|ttf)$/i;

export type ExtractedMention = { domain: string; targetUrl: string; anchorText: string | null; rel: string | null };

export function normalizePageUrl(value: URL) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

// Listing pages carry no editorial links of their own; sitemaps list thousands of them.
const listingPathPattern = /\/(?:tag|tags|topic|topics|category|categories|author|authors|contributor|video|videos|gallery|galleries|photos|page|search|feed|amp)(?:\/|$)/i;

export function isArticleLikeUrl(url: URL) {
  return url.pathname !== "/" && !listingPathPattern.test(url.pathname);
}

export function isCrawlableUrl(url: URL, sourceDomain: string) {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    registrableDomain(url.hostname)?.domain === sourceDomain &&
    !ignoredExtensions.test(url.pathname)
  );
}

function publishedDate($: cheerio.CheerioAPI) {
  const candidates = [
    $("meta[property='article:published_time']").attr("content"),
    $("meta[itemprop='datePublished']").attr("content"),
    $("meta[name='pubdate']").attr("content"),
    $("meta[name='publish-date']").attr("content"),
    $("time[datetime]").first().attr("datetime"),
    /"datePublished"\s*:\s*"([^"]+)"/.exec($("script[type='application/ld+json']").text())?.[1],
  ];
  for (const value of candidates) {
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

export function extractPage(html: string, pageUrl: string, sourceDomain: string) {
  const $ = cheerio.load(html);
  const internalLinks = new Set<string>();

  // Internal links are collected from the whole page (navigation helps crawling).
  $("a[href]").each((_, element) => {
    try {
      const url = new URL($(element).attr("href")!, pageUrl);
      if (isCrawlableUrl(url, sourceDomain)) internalLinks.add(normalizePageUrl(url));
    } catch {
      // Ignore malformed hrefs.
    }
  });

  const publishedAt = publishedDate($);
  const body = articleBodySelectors.map((selector) => $(selector)).find((match) => match.length > 0) ?? $("body");
  body.find(boilerplateSelectors).remove();

  const mentions = new Map<string, ExtractedMention>();
  body.find("a[href]").each((_, element) => {
    try {
      const link = new URL($(element).attr("href")!.trim(), pageUrl);
      const domain = candidateDomain(link, sourceDomain);
      if (!domain) return;
      link.hash = "";
      const targetUrl = link.toString().slice(0, 2000);
      if (mentions.has(targetUrl)) return;
      const anchorText = $(element).text().replace(/\s+/g, " ").trim().slice(0, 300) || null;
      mentions.set(targetUrl, { domain, targetUrl, anchorText, rel: $(element).attr("rel") ?? null });
    } catch {
      // Ignore malformed hrefs.
    }
  });

  return { publishedAt, mentions: [...mentions.values()], internalLinks: [...internalLinks] };
}
