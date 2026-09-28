-- CreateEnum
CREATE TYPE "DomainAvailability" AS ENUM ('UNCHECKED', 'REGISTERED', 'EXPIRING', 'REDEMPTION', 'PENDING_DELETE', 'AVAILABLE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ScanMode" AS ENUM ('SITEMAP', 'CRAWL');

-- CreateEnum
CREATE TYPE "ScanJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SourcePageStatus" AS ENUM ('PENDING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "DroppedDomain" ADD COLUMN     "linkedDomainId" TEXT;

-- AlterTable
ALTER TABLE "SourceSite" ADD COLUMN     "mode" "ScanMode" NOT NULL DEFAULT 'SITEMAP';

-- CreateTable
CREATE TABLE "SourcePage" (
    "id" TEXT NOT NULL,
    "sourceSiteId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" "SourcePageStatus" NOT NULL DEFAULT 'PENDING',
    "depth" INTEGER NOT NULL DEFAULT 0,
    "lastmod" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourcePage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanJob" (
    "id" TEXT NOT NULL,
    "sourceSiteId" TEXT NOT NULL,
    "status" "ScanJobStatus" NOT NULL DEFAULT 'QUEUED',
    "phase" TEXT NOT NULL DEFAULT 'waiting',
    "pagesTotal" INTEGER NOT NULL DEFAULT 0,
    "pagesDone" INTEGER NOT NULL DEFAULT 0,
    "pagesFailed" INTEGER NOT NULL DEFAULT 0,
    "domainsFound" INTEGER NOT NULL DEFAULT 0,
    "mentionsFound" INTEGER NOT NULL DEFAULT 0,
    "lastMessage" TEXT,
    "error" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkedDomain" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "availability" "DomainAvailability" NOT NULL DEFAULT 'UNCHECKED',
    "rdapStatuses" TEXT[],
    "registeredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "registrar" TEXT,
    "checkedAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkError" TEXT,
    "mentionCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkedDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainMention" (
    "id" TEXT NOT NULL,
    "linkedDomainId" TEXT NOT NULL,
    "sourcePageId" TEXT NOT NULL,
    "sourceSiteId" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "anchorText" TEXT,
    "rel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DomainMention_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SourcePage_sourceSiteId_status_idx" ON "SourcePage"("sourceSiteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SourcePage_sourceSiteId_url_key" ON "SourcePage"("sourceSiteId", "url");

-- CreateIndex
CREATE INDEX "ScanJob_status_idx" ON "ScanJob"("status");

-- CreateIndex
CREATE UNIQUE INDEX "LinkedDomain_name_key" ON "LinkedDomain"("name");

-- CreateIndex
CREATE INDEX "LinkedDomain_availability_idx" ON "LinkedDomain"("availability");

-- CreateIndex
CREATE INDEX "LinkedDomain_nextCheckAt_idx" ON "LinkedDomain"("nextCheckAt");

-- CreateIndex
CREATE INDEX "DomainMention_sourceSiteId_idx" ON "DomainMention"("sourceSiteId");

-- CreateIndex
CREATE UNIQUE INDEX "DomainMention_linkedDomainId_sourcePageId_targetUrl_key" ON "DomainMention"("linkedDomainId", "sourcePageId", "targetUrl");

-- CreateIndex
CREATE UNIQUE INDEX "DroppedDomain_linkedDomainId_key" ON "DroppedDomain"("linkedDomainId");

-- AddForeignKey
ALTER TABLE "SourcePage" ADD CONSTRAINT "SourcePage_sourceSiteId_fkey" FOREIGN KEY ("sourceSiteId") REFERENCES "SourceSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanJob" ADD CONSTRAINT "ScanJob_sourceSiteId_fkey" FOREIGN KEY ("sourceSiteId") REFERENCES "SourceSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainMention" ADD CONSTRAINT "DomainMention_linkedDomainId_fkey" FOREIGN KEY ("linkedDomainId") REFERENCES "LinkedDomain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainMention" ADD CONSTRAINT "DomainMention_sourcePageId_fkey" FOREIGN KEY ("sourcePageId") REFERENCES "SourcePage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainMention" ADD CONSTRAINT "DomainMention_sourceSiteId_fkey" FOREIGN KEY ("sourceSiteId") REFERENCES "SourceSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DroppedDomain" ADD CONSTRAINT "DroppedDomain_linkedDomainId_fkey" FOREIGN KEY ("linkedDomainId") REFERENCES "LinkedDomain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

