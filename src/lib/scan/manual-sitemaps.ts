// Kept apart from sitemap.ts so API routes can validate input without loading the fetcher (and Playwright).
const maxManualSitemaps = 50;

/** Validates sitemap URLs entered by hand (an array, or text with one URL per line). Returns an error message for bad input. */
export function parseManualSitemaps(value: unknown): { urls: string[] } | { error: string } {
  const lines = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\r\n,]+/) : value == null ? [] : null;
  if (!lines) return { error: "Sitemap listesi geçersiz." };
  const urls = new Set<string>();
  for (const line of lines) {
    const text = String(line).trim();
    if (!text) continue;
    try {
      const url = new URL(text);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
      urls.add(url.toString());
    } catch {
      return { error: `Geçersiz sitemap URL'si: ${text}` };
    }
  }
  if (urls.size > maxManualSitemaps) return { error: `En fazla ${maxManualSitemaps} sitemap girilebilir.` };
  return { urls: [...urls] };
}
