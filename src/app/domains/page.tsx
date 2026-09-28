import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink, History, Search } from "lucide-react";

import type { DomainAvailability, Prisma } from "@/generated/prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { candidateAvailabilities } from "@/lib/scan/rdap";

const pageSize = 50;

const availabilityLabels: Record<DomainAvailability, string> = {
  AVAILABLE: "Kayıt edilebilir",
  PENDING_DELETE: "Silinmek üzere",
  REDEMPTION: "Redemption",
  EXPIRING: "Süresi dolmuş / dolmak üzere",
  REGISTERED: "Kayıtlı",
  UNCHECKED: "Kontrol bekliyor",
  UNKNOWN: "Kontrol edilemedi",
};

const tabs: Array<{ key: string; label: string }> = [
  { key: "candidates", label: "Tüm adaylar" },
  { key: "AVAILABLE", label: "Kayıt edilebilir" },
  { key: "PENDING_DELETE", label: "Silinmek üzere" },
  { key: "REDEMPTION", label: "Redemption" },
  { key: "EXPIRING", label: "Süresi dolmuş" },
  { key: "UNCHECKED", label: "Kontrol bekliyor" },
  { key: "UNKNOWN", label: "Hatalı" },
  { key: "REGISTERED", label: "Kayıtlı" },
];

const sorts: Record<string, { label: string; orderBy: Prisma.LinkedDomainOrderByWithRelationInput[] }> = {
  mentions: { label: "En çok link alan", orderBy: [{ mentionCount: "desc" }, { name: "asc" }] },
  expires: { label: "Son kullanma tarihi", orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { name: "asc" }] },
  recent: { label: "Yeni bulunan", orderBy: [{ firstSeenAt: "desc" }] },
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

function param(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatDate(value: Date | null) {
  return value ? value.toLocaleDateString("tr-TR") : "-";
}

function isNofollow(rel: string | null) {
  return rel ? /nofollow|sponsored|ugc/i.test(rel) : false;
}

export default async function DomainsPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await getSession();
  if (!session?.fullAccess) redirect("/login");

  const params = await searchParams;
  const tab = tabs.some((item) => item.key === param(params.status)) ? param(params.status)! : "candidates";
  const sort = param(params.sort) && sorts[param(params.sort)!] ? param(params.sort)! : "mentions";
  const sourceId = param(params.source) || undefined;
  const query = param(params.q)?.trim().toLowerCase() || undefined;
  const page = Math.max(1, Number(param(params.page)) || 1);

  const baseWhere: Prisma.LinkedDomainWhereInput = {
    ...(sourceId ? { mentions: { some: { sourceSiteId: sourceId } } } : {}),
    ...(query ? { name: { contains: query } } : {}),
  };
  const where: Prisma.LinkedDomainWhereInput = {
    ...baseWhere,
    availability: tab === "candidates" ? { in: candidateAvailabilities } : (tab as DomainAvailability),
  };

  const [domains, total, grouped, sources] = await Promise.all([
    prisma.linkedDomain.findMany({
      where,
      orderBy: sorts[sort].orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        dropped: { select: { status: true } },
        mentions: {
          where: sourceId ? { sourceSiteId: sourceId } : undefined,
          orderBy: { createdAt: "asc" },
          take: 8,
          include: { sourcePage: { select: { url: true, publishedAt: true, lastmod: true } }, sourceSite: { select: { name: true } } },
        },
      },
    }),
    prisma.linkedDomain.count({ where }),
    prisma.linkedDomain.groupBy({ by: ["availability"], where: baseWhere, _count: true }),
    prisma.sourceSite.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  const countFor = (key: string) =>
    key === "candidates"
      ? grouped.filter((row) => candidateAvailabilities.includes(row.availability)).reduce((sum, row) => sum + row._count, 0)
      : grouped.find((row) => row.availability === key)?._count ?? 0;

  const href = (changes: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();
    const merged = { status: tab, sort, source: sourceId, q: query, page: undefined as number | undefined, ...changes };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== "" && !(key === "status" && value === "candidates") && !(key === "sort" && value === "mentions")) next.set(key, String(value));
    }
    const search = next.toString();
    return search ? `/domains?${search}` : "/domains";
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <main className="sources-page">
      <div className="sources-wrap domains-wrap">
        <Link href="/sources" className="back-link"><ArrowLeft size={15} /> Kaynaklara dön</Link>
        <header className="sources-heading">
          <div>
            <p className="eyebrow">BULUNAN DOMAINLER</p>
            <h1>Düşen .com domainler</h1>
            <p>Haber arşivlerinden link alan ve kaydı düşmüş, düşmek üzere olan ya da süresi dolmuş domainler.</p>
          </div>
          <div className="source-summary"><Search size={20} /><strong>{countFor("candidates").toLocaleString("tr-TR")}</strong><span>aday domain</span></div>
        </header>

        <nav className="domain-tabs" aria-label="Durum filtresi">
          {tabs.map((item) => (
            <Link key={item.key} href={href({ status: item.key })} className={item.key === tab ? "active" : ""}>
              {item.label} <b>{countFor(item.key).toLocaleString("tr-TR")}</b>
            </Link>
          ))}
        </nav>

        <form className="domain-filters" action="/domains">
          {tab !== "candidates" ? <input type="hidden" name="status" value={tab} /> : null}
          <input name="q" defaultValue={query} placeholder="Domain ara..." />
          <select name="source" defaultValue={sourceId ?? ""} aria-label="Kaynak">
            <option value="">Tüm kaynaklar</option>
            {sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
          </select>
          <select name="sort" defaultValue={sort} aria-label="Sıralama">
            {Object.entries(sorts).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
          </select>
          <button type="submit">Filtrele</button>
        </form>

        <section className="source-list domain-list">
          {domains.length === 0 ? <div className="empty-source">Bu filtrede domain yok. Tarama sürüyorsa kontroller bitince burada görünecek.</div> : domains.map((domain) => {
            const followCount = domain.mentions.filter((mention) => !isNofollow(mention.rel)).length;
            return (
              <details className="domain-row" key={domain.id}>
                <summary>
                  <div className="domain-main">
                    <strong>{domain.name}</strong>
                    <span className={`availability availability-${domain.availability.toLowerCase()}`}>{availabilityLabels[domain.availability]}</span>
                    {domain.dropped && domain.dropped.status !== "DISCOVERED" ? <span className="mode-tag">{domain.dropped.status}</span> : null}
                  </div>
                  <div className="source-stat"><strong>{domain.mentionCount.toLocaleString("tr-TR")}</strong><span>link</span></div>
                  <div className="source-stat"><strong>{formatDate(domain.expiresAt)}</strong><span>bitiş</span></div>
                  <div className="source-stat"><strong>{formatDate(domain.checkedAt)}</strong><span>son kontrol</span></div>
                </summary>
                <div className="domain-detail">
                  <div className="domain-meta-line">
                    {domain.registrar ? <span>Registrar: {domain.registrar}</span> : null}
                    {domain.registeredAt ? <span>İlk kayıt: {formatDate(domain.registeredAt)}</span> : null}
                    {domain.rdapStatuses.length ? <span>RDAP: {domain.rdapStatuses.join(", ")}</span> : null}
                    {domain.checkError ? <span className="job-error">Hata: {domain.checkError}</span> : null}
                    <span>İlk {domain.mentions.length} linkten {followCount} tanesi dofollow</span>
                    <a href={`https://web.archive.org/web/*/${domain.name}`} target="_blank" rel="noreferrer"><History size={11} /> Wayback</a>
                  </div>
                  <ul className="mention-list">
                    {domain.mentions.map((mention) => (
                      <li key={mention.id}>
                        <a href={mention.sourcePage.url} target="_blank" rel="noreferrer">{mention.sourcePage.url} <ExternalLink size={10} /></a>
                        <span>
                          {mention.sourceSite.name}
                          {mention.sourcePage.publishedAt ?? mention.sourcePage.lastmod ? ` · ${formatDate(mention.sourcePage.publishedAt ?? mention.sourcePage.lastmod)}` : ""}
                          {` · "${mention.anchorText ?? "—"}" → ${mention.targetUrl}`}
                          {isNofollow(mention.rel) ? ` · ${mention.rel}` : " · dofollow"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            );
          })}
        </section>

        {totalPages > 1 ? (
          <nav className="pager" aria-label="Sayfalama">
            {page > 1 ? <Link href={href({ page: page - 1 })}>← Önceki</Link> : <span />}
            <span>{page} / {totalPages}</span>
            {page < totalPages ? <Link href={href({ page: page + 1 })}>Sonraki →</Link> : <span />}
          </nav>
        ) : null}
      </div>
    </main>
  );
}
