import { parse } from "tldts";

// Only .com domains are tracked (product decision).
const allowedSuffixes = new Set(["com"]);

// Always-registered giants and platform domains: never worth a registry lookup.
const ignoredDomains = new Set([
  "google.com", "youtube.com", "facebook.com", "twitter.com", "instagram.com", "linkedin.com",
  "pinterest.com", "reddit.com", "tiktok.com", "whatsapp.com", "snapchat.com", "tumblr.com",
  "amazon.com", "apple.com", "microsoft.com", "yahoo.com", "bing.com", "wikipedia.com",
  "wordpress.com", "blogspot.com", "medium.com", "substack.com", "github.com", "gitlab.com",
  "cloudflare.com", "doubleclick.com", "googletagmanager.com", "googleapis.com",
  "gstatic.com", "googlesyndication.com", "googleusercontent.com", "adobe.com", "vimeo.com",
  "spotify.com", "soundcloud.com", "flickr.com", "imgur.com", "gravatar.com", "disqus.com",
  "paypal.com", "ebay.com", "netflix.com", "nytimes.com", "washingtonpost.com", "cnn.com",
  "foxnews.com", "nbcnews.com", "cbsnews.com", "usatoday.com", "wsj.com", "bloomberg.com",
  "reuters.com", "forbes.com", "cnbc.com", "espn.com", "theatlantic.com", "politico.com",
  "businessinsider.com", "huffpost.com", "latimes.com", "dropbox.com", "zoom.com",
  "x.com", "threads.com", "mailchimp.com",
  "eventbrite.com", "gofundme.com", "patreon.com",
]);

export function registrableDomain(hostname: string) {
  const info = parse(hostname.toLowerCase());
  if (!info.domain || info.isIp || !info.isIcann) return null;
  return { domain: info.domain, suffix: info.publicSuffix ?? "" };
}

/** Returns the registrable .com domain for a link, or null if it should not be tracked. */
export function candidateDomain(link: URL, sourceDomain: string) {
  if (link.protocol !== "http:" && link.protocol !== "https:") return null;
  const info = registrableDomain(link.hostname);
  if (!info || !allowedSuffixes.has(info.suffix)) return null;
  if (info.domain === sourceDomain || ignoredDomains.has(info.domain)) return null;
  return info.domain;
}
