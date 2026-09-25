-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('DISCOVERED', 'REVIEWING', 'AVAILABLE', 'ASSIGNED', 'PURCHASED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "SourceSite" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastScanned" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DroppedDomain" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceSiteId" TEXT NOT NULL,
    "status" "DomainStatus" NOT NULL DEFAULT 'DISCOVERED',
    "domainAgeYears" INTEGER,
    "domainAuthority" INTEGER,
    "backlinkCount" INTEGER,
    "estimatedValue" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DroppedDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "company" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainAssignment" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purchaseCost" INTEGER,
    "notes" TEXT,

    CONSTRAINT "DomainAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SourceSite_url_key" ON "SourceSite"("url");

-- CreateIndex
CREATE UNIQUE INDEX "DroppedDomain_name_key" ON "DroppedDomain"("name");

-- CreateIndex
CREATE UNIQUE INDEX "DomainAssignment_domainId_key" ON "DomainAssignment"("domainId");

-- AddForeignKey
ALTER TABLE "DroppedDomain" ADD CONSTRAINT "DroppedDomain_sourceSiteId_fkey" FOREIGN KEY ("sourceSiteId") REFERENCES "SourceSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainAssignment" ADD CONSTRAINT "DomainAssignment_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "DroppedDomain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainAssignment" ADD CONSTRAINT "DomainAssignment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
