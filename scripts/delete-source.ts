import { prisma } from "../src/lib/db";

// Usage: npx tsx scripts/delete-source.ts <url-part> [--confirm]
// Without --confirm it only prints what would be deleted.
const batchSize = 2000;

async function main() {
  const [match, flag] = process.argv.slice(2);
  if (!match) throw new Error("Usage: npx tsx scripts/delete-source.ts <url-part> [--confirm]");
  const confirm = flag === "--confirm";

  const sources = await prisma.sourceSite.findMany({ where: { url: { contains: match } } });
  if (sources.length === 0) {
    console.log(`No source matches "${match}".`);
    return;
  }

  for (const source of sources) {
    const [pages, mentions, jobs, dropped, assigned] = await Promise.all([
      prisma.sourcePage.count({ where: { sourceSiteId: source.id } }),
      prisma.domainMention.count({ where: { sourceSiteId: source.id } }),
      prisma.scanJob.count({ where: { sourceSiteId: source.id } }),
      prisma.droppedDomain.count({ where: { sourceSiteId: source.id } }),
      prisma.domainAssignment.count({ where: { domain: { sourceSiteId: source.id } } }),
    ]);
    console.log(`${source.name} (${source.url}): ${pages} pages, ${mentions} mentions, ${jobs} jobs, ${dropped} dropped domains, ${assigned} client assignments`);

    if (assigned > 0) {
      console.log("  Skipped: domains from this source are assigned to clients.");
      continue;
    }
    if (!confirm) continue;

    // Stop scans first so the worker does not write new pages while they are being deleted.
    await prisma.scanJob.updateMany({ where: { sourceSiteId: source.id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", finishedAt: new Date() } });
    await prisma.sourceSite.update({ where: { id: source.id }, data: { isActive: false } });

    while (true) {
      const removed = await prisma.$queryRaw<Array<{ linkedDomainId: string }>>`
        DELETE FROM "DomainMention" WHERE "id" IN (
          SELECT "id" FROM "DomainMention" WHERE "sourceSiteId" = ${source.id} LIMIT ${batchSize}
        ) RETURNING "linkedDomainId"`;
      if (removed.length === 0) break;
      const ids = [...new Set(removed.map((row) => row.linkedDomainId))];
      await prisma.$executeRaw`
        UPDATE "LinkedDomain" SET "mentionCount" = (
          SELECT count(*) FROM "DomainMention" m WHERE m."linkedDomainId" = "LinkedDomain"."id"
        ) WHERE "id" = ANY(${ids})`;
    }
    while (
      (await prisma.$executeRaw`
        DELETE FROM "SourcePage" WHERE "id" IN (
          SELECT "id" FROM "SourcePage" WHERE "sourceSiteId" = ${source.id} LIMIT ${batchSize}
        )`) > 0
    ) {
      // Keep going until the source has no pages left.
    }
    // Jobs and dropped domains cascade with the source.
    await prisma.sourceSite.delete({ where: { id: source.id } });
    console.log("  Deleted.");
  }

  if (!confirm) console.log("\nDry run. Re-run with --confirm to delete.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
