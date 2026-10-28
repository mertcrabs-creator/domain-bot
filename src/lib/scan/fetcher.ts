import { gunzipSync } from "node:zlib";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const requestTimeoutMs = 15_000;
const maxBodyBytes = 8 * 1024 * 1024;
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const blockedStatuses = new Set([401, 403, 503]);
const challengePattern = /just a moment|cf-chl|captcha|access denied|are you a robot/i;
// A Cloudflare JS check finishes on its own in a real browser within a few seconds; an interactive CAPTCHA never does.
const challengeTimeoutMs = 25_000;
const navigationTimeoutMs = 30_000;
// Browser tabs are heavy; the scan's page lanes share this many.
const maxBrowserPages = Math.max(1, Number(process.env.SCANNER_BROWSER_PAGES ?? 3));
const defaultBackoffMs = 30_000;
const maxBackoffMs = 5 * 60_000;
// Images, fonts and media are not needed to read links and only slow the page down.
const skippedResourceTypes = new Set(["image", "media", "font"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type FetchResult = { status: number; body: string | null; finalUrl: string; retryAfterMs?: number | null };

function parseRetryAfter(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

export async function fetchRaw(url: string, accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"): Promise<FetchResult> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: { accept, "accept-language": "en-US,en;q=0.9", "user-agent": userAgent },
  });
  if (!response.ok) {
    return { status: response.status, body: null, finalUrl: response.url || url, retryAfterMs: parseRetryAfter(response.headers.get("retry-after")) };
  }

  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxBodyBytes) return { status: response.status, body: null, finalUrl: response.url };

  let buffer = Buffer.from(await response.arrayBuffer());
  // Sitemaps are often served as raw .gz files that fetch does not transparently decode.
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = gunzipSync(buffer);
  return { status: response.status, body: buffer.toString("utf8"), finalUrl: response.url || url };
}

/** True while the page still shows a challenge/interstitial instead of the article. */
async function isChallengePage(page: Page) {
  return page.evaluate(() => {
    const title = document.title.toLowerCase();
    return (
      /just a moment|attention required|bir dakika|un instant|einen moment/.test(title) ||
      Boolean(document.querySelector("#challenge-running, #challenge-form, #cf-challenge-running, [name='cf-turnstile-response']"))
    );
  });
}

/**
 * Fetches pages the way a regular visitor's browser would, one per scan.
 * Plain requests are tried first; a host that answers with a block or a JS check is from then on read through one
 * headless browser session, which waits for the check to finish and keeps its cookies, so the check is passed once
 * and not on every page. Interactive CAPTCHAs are not solved: those pages fail.
 * Rate limits (429 / Retry-After) pause all requests to that host, and the pause grows while they keep coming.
 */
export class PageFetcher {
  private browser: Promise<Browser> | null = null;
  private context: Promise<BrowserContext> | null = null;
  private browserHosts = new Set<string>();
  private pausedUntil = new Map<string, number>();
  private backoffMs = new Map<string, number>();
  private openPages = 0;
  private pageWaiters: Array<() => void> = [];

  async fetchHtml(url: string): Promise<FetchResult> {
    const host = new URL(url).hostname;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.waitWhilePaused(host);
      const result = this.browserHosts.has(host) ? await this.fetchWithBrowser(url) : await this.fetchPlain(url, host);
      if (result.status !== 429) {
        if (result.body) this.backoffMs.delete(host);
        return result;
      }
      this.slowDown(host, result.retryAfterMs ?? null);
    }
    return { status: 429, body: null, finalUrl: url };
  }

  private async fetchPlain(url: string, host: string): Promise<FetchResult> {
    let result: FetchResult | null = null;
    try {
      result = await fetchRaw(url);
      if (result.status === 429) return result;
      const blocked = blockedStatuses.has(result.status) || (result.body !== null && challengePattern.test(result.body.slice(0, 5000)));
      if (!blocked) return result;
      this.browserHosts.add(host);
    } catch {
      // Network errors and timeouts fall through to the browser.
    }
    return this.fetchWithBrowser(url);
  }

  private async waitWhilePaused(host: string) {
    const until = this.pausedUntil.get(host) ?? 0;
    if (until > Date.now()) await sleep(until - Date.now());
  }

  private slowDown(host: string, retryAfterMs: number | null) {
    const backoff = Math.min(maxBackoffMs, (this.backoffMs.get(host) ?? defaultBackoffMs / 2) * 2);
    this.backoffMs.set(host, backoff);
    const wait = Math.min(maxBackoffMs, Math.max(retryAfterMs ?? 0, backoff));
    this.pausedUntil.set(host, Math.max(this.pausedUntil.get(host) ?? 0, Date.now() + wait));
  }

  private getContext() {
    this.browser ??= chromium.launch({ headless: true });
    this.context ??= this.browser.then(async (browser) => {
      const context = await browser.newContext({ userAgent, locale: "en-US", viewport: { width: 1366, height: 768 } });
      await context.route("**/*", (route) => (skippedResourceTypes.has(route.request().resourceType()) ? route.abort() : route.continue()));
      return context;
    });
    return this.context;
  }

  private async acquirePage() {
    while (this.openPages >= maxBrowserPages) await new Promise<void>((resolve) => this.pageWaiters.push(resolve));
    this.openPages += 1;
  }

  private releasePage() {
    this.openPages -= 1;
    this.pageWaiters.shift()?.();
  }

  private async fetchWithBrowser(url: string): Promise<FetchResult> {
    await this.acquirePage();
    let page: Page | null = null;
    try {
      page = await (await this.getContext()).newPage();
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
      const firstStatus = response?.status() ?? 0;
      if (firstStatus === 429) return { status: 429, body: null, finalUrl: page.url(), retryAfterMs: parseRetryAfter((await response?.allHeaders())?.["retry-after"] ?? null) };
      if (firstStatus === 404 || firstStatus === 410) return { status: firstStatus, body: null, finalUrl: page.url() };

      // The check reloads the page when it passes, so the state is polled rather than awaited once.
      let challenged = true;
      const deadline = Date.now() + challengeTimeoutMs;
      while (Date.now() < deadline) {
        try {
          challenged = await isChallengePage(page);
          if (!challenged) break;
        } catch {
          // The page is navigating away from the check.
        }
        await sleep(1000);
      }
      if (challenged) return { status: 403, body: null, finalUrl: page.url() };
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);

      const html = await page.content();
      if (challengePattern.test(html.slice(0, 5000)) && html.length < 50_000) return { status: 403, body: null, finalUrl: page.url() };
      // After a passed check the first response was the check itself (403/503), so a clean page counts as 200.
      const status = blockedStatuses.has(firstStatus) ? 200 : firstStatus;
      return { status, body: status < 400 ? html : null, finalUrl: page.url() };
    } catch {
      return { status: 0, body: null, finalUrl: url };
    } finally {
      await page?.close().catch(() => undefined);
      this.releasePage();
    }
  }

  async close() {
    const context = await this.context?.catch(() => null);
    const browser = await this.browser?.catch(() => null);
    this.context = null;
    this.browser = null;
    await context?.close().catch(() => undefined);
    await browser?.close();
  }
}
