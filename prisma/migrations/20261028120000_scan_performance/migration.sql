-- The worker reads PENDING pages oldest first; this index serves that order directly (it also covers the old (sourceSiteId, status) prefix).
CREATE INDEX IF NOT EXISTS "SourcePage_sourceSiteId_status_lastmod_createdAt_idx" ON "SourcePage"("sourceSiteId", "status", "lastmod", "createdAt");
DROP INDEX IF EXISTS "SourcePage_sourceSiteId_status_idx";

-- Domains expiring within a year are now candidates: re-check the registered ones that already fall in that window.
UPDATE "LinkedDomain" SET "nextCheckAt" = CURRENT_TIMESTAMP
WHERE "availability" = 'REGISTERED' AND "expiresAt" < CURRENT_TIMESTAMP + INTERVAL '365 days';
