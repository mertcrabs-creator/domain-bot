-- Sitemap pages are split into batches of 50,000 that are crawled one by one, each by a manually started job.
ALTER TABLE "SourcePage" ADD COLUMN IF NOT EXISTS "batch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ScanJob" ADD COLUMN IF NOT EXISTS "batch" INTEGER;

CREATE TABLE IF NOT EXISTS "PageBatch" (
    "id" TEXT NOT NULL,
    "sourceSiteId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "pagesTotal" INTEGER NOT NULL DEFAULT 0,
    "pagesDone" INTEGER NOT NULL DEFAULT 0,
    "pagesFailed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PageBatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PageBatch_sourceSiteId_number_key" ON "PageBatch"("sourceSiteId", "number");
DO $$ BEGIN
    ALTER TABLE "PageBatch" ADD CONSTRAINT "PageBatch_sourceSiteId_fkey" FOREIGN KEY ("sourceSiteId") REFERENCES "SourceSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DROP INDEX IF EXISTS "SourcePage_sourceSiteId_status_lastmod_createdAt_idx";
DROP INDEX IF EXISTS "SourcePage_sourceSiteId_status_idx";
CREATE INDEX IF NOT EXISTS "SourcePage_sourceSiteId_batch_status_lastmod_createdAt_idx" ON "SourcePage"("sourceSiteId", "batch", "status", "lastmod", "createdAt");

-- Split the pages already found for sitemap sources, oldest articles first (the same order the worker uses).
UPDATE "SourcePage" p SET "batch" = v.batch
FROM (
    SELECT sp."id", (row_number() OVER (PARTITION BY sp."sourceSiteId" ORDER BY sp."lastmod" ASC NULLS LAST, sp."createdAt", sp."id") - 1) / 50000 + 1 AS batch
    FROM "SourcePage" sp JOIN "SourceSite" s ON s."id" = sp."sourceSiteId"
    WHERE s."mode" = 'SITEMAP' AND sp."batch" = 0
) v
WHERE p."id" = v."id";

INSERT INTO "PageBatch" ("id", "sourceSiteId", "number", "pagesTotal", "pagesDone", "pagesFailed")
SELECT gen_random_uuid()::text, "sourceSiteId", "batch", count(*), count(*) FILTER (WHERE "status" = 'DONE'), count(*) FILTER (WHERE "status" = 'FAILED')
FROM "SourcePage" WHERE "batch" > 0
GROUP BY "sourceSiteId", "batch"
ON CONFLICT ("sourceSiteId", "number") DO UPDATE SET
    "pagesTotal" = EXCLUDED."pagesTotal", "pagesDone" = EXCLUDED."pagesDone", "pagesFailed" = EXCLUDED."pagesFailed";
