import { gunzipSync } from "node:zlib";
import { chromium, type Browser } from "playwright";

const requestTimeoutMs = 15_000;
const maxBodyBytes = 8 * 1024 * 1024;
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const blockedStatuses = new Set([401, 403, 429, 503]);
const challengePattern = /just a moment|cf-chl|captcha|access denied|are you a robot/i;

export type FetchResult = { status: number; body: string | null; finalUrl: string };

export async function fetchRaw(url: string, accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"): Promise<FetchResult> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: { accept, "accept-language": "en-US,en;q=0.9", "user-agent": userAgent },
  });
  if (!response.ok) return { status: response.status, body: null, finalUrl: response.url || url };

  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxBodyBytes) return { status: response.status, body: null, finalUrl: response.url };

  let buffer = Buffer.from(await response.arrayBuffer());
  // Sitemaps are often served as raw .gz files that fetch does not transparently decode.
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = gunzipSync(buffer);
  return { status: response.status, body: buffer.toString("utf8"), finalUrl: response.url || url };
}

/** Lazily launches one headless browser per scan and only when a site blocks plain requests. */
export class PageFetcher {
  private browser: Promise<Browser> | null = null;

  async fetchHtml(url: string): Promise<FetchResult> {
    let result: FetchResult | null = null;
    try {
      result = await fetchRaw(url);
      const blocked = blockedStatuses.has(result.status) || (result.body !== null && challengePattern.test(result.body.slice(0, 5000)));
      if (!blocked) return result;
    } catch {
      // Network errors and timeouts fall through to the browser.
    }
    return this.fetchWithBrowser(url, result);
  }

  private async fetchWithBrowser(url: string, previous: FetchResult | null): Promise<FetchResult> {
    this.browser ??= chromium.launch({ headless: true });
    const browser = await this.browser;
    const page = await browser.newPage({ userAgent });
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(1500);
      const html = await page.content();
      const status = response?.status() ?? previous?.status ?? 0;
      if (challengePattern.test(html.slice(0, 5000)) && html.length < 50_000) return { status: 403, body: null, finalUrl: page.url() };
      return { status, body: status < 400 ? html : null, finalUrl: page.url() };
    } finally {
      await page.close();
    }
  }

  async close() {
    if (!this.browser) return;
    const browser = await this.browser.catch(() => null);
    this.browser = null;
    await browser?.close();
  }
}
