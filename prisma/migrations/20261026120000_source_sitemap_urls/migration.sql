-- Sitemap URLs entered by hand for sources whose sitemaps cannot be discovered automatically.
ALTER TABLE "SourceSite" ADD COLUMN IF NOT EXISTS "sitemapUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];
