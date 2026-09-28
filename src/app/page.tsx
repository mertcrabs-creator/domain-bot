import { redirect } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Activity, ArrowUpRight, Bell, ChevronDown, CircleHelp, Clock3, Database, ExternalLink, FileText, Globe2, LayoutDashboard, MoreHorizontal, Plus, Radar, Settings2, Users } from "lucide-react";

import type { DomainAvailability } from "@/generated/prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { candidateAvailabilities } from "@/lib/scan/rdap";

const availabilityTone: Partial<Record<DomainAvailability, { label: string; tone: string }>> = {
  AVAILABLE: { label: "Kayıt edilebilir", tone: "new" },
  PENDING_DELETE: { label: "Silinmek üzere", tone: "review" },
  REDEMPTION: { label: "Redemption", tone: "review" },
  EXPIRING: { label: "Süresi dolmuş", tone: "assigned" },
};

const dayMs = 24 * 60 * 60 * 1000;
const clientColors = ["gold", "blue", "red"];

async function getDashboard() {
  const weekAgo = new Date(Date.now() - 7 * dayMs);
  const [candidateCount, availableCount, trackedCount, weeklyDropped, pagesScanned, clientCount, latestCandidates, clients, activity] = await Promise.all([
    prisma.linkedDomain.count({ where: { availability: { in: candidateAvailabilities } } }),
    prisma.linkedDomain.count({ where: { availability: "AVAILABLE" } }),
    prisma.linkedDomain.count(),
    prisma.droppedDomain.count({ where: { discoveredAt: { gte: weekAgo } } }),
    prisma.sourcePage.count({ where: { status: "DONE" } }),
    prisma.client.count(),
    prisma.linkedDomain.findMany({
      where: { availability: { in: candidateAvailabilities } },
      orderBy: [{ checkedAt: "desc" }],
      take: 6,
      include: { dropped: { select: { sourceSite: { select: { name: true } } } } },
    }),
    prisma.client.findMany({ orderBy: { createdAt: "desc" }, take: 3, include: { _count: { select: { assignments: true } } } }),
    prisma.droppedDomain.findMany({ where: { discoveredAt: { gte: weekAgo } }, select: { discoveredAt: true } }),
  ]);

  const days = Array.from({ length: 7 }, (_, index) => {
    const start = new Date(Date.now() - (6 - index) * dayMs);
    start.setHours(0, 0, 0, 0);
    const end = start.getTime() + dayMs;
    const count = activity.filter((item) => item.discoveredAt >= start && item.discoveredAt.getTime() < end).length;
    return { label: start.toLocaleDateString("tr-TR", { weekday: "short" }), count };
  });
  const today = new Date().toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric", weekday: "long" }).toLocaleUpperCase("tr-TR");

  return { candidateCount, availableCount, trackedCount, weeklyDropped, pagesScanned, clientCount, latestCandidates, clients, days, today };
}

export default async function Home() {
  const session = await getSession();

  if (!session || !session.fullAccess) {
    redirect("/login");
  }

  const { candidateCount, availableCount, trackedCount, weeklyDropped, pagesScanned, clientCount, latestCandidates, clients, days, today } = await getDashboard();
  const maxDay = Math.max(1, ...days.map((day) => day.count));
  const number = (value: number) => value.toLocaleString("tr-TR");

  const navItems = [
    { label: "Genel Bakış", icon: LayoutDashboard, href: "/", active: true },
    { label: "Düşen Domainler", icon: Radar, href: "/domains", count: number(candidateCount) },
    { label: "Kaynak Siteler", icon: Globe2, href: "/sources" },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Image src="https://www.crabsmedia.com/wp-content/uploads/2025/02/logo.png" alt="Crabs Media" width={27} height={27} /></span><span>domain<span className="brand-dot">.</span>bot</span></div>
        <div className="workspace-switcher"><div><span className="workspace-label">ÇALIŞMA ALANI</span><strong>Crabs Media</strong></div><ChevronDown size={15} /></div>
        <nav className="nav-list" aria-label="Ana navigasyon"><span className="nav-section-label">PANEL</span>{navItems.map((item) => <Link className={`nav-item${item.active ? " active" : ""}`} href={item.href} key={item.label}><item.icon /><span>{item.label}</span>{item.count && <b>{item.count}</b>}</Link>)}<button className="nav-item"><Users size={17} /><span>Müşteriler</span></button><span className="nav-section-label">YÖNETİM</span><Link className="nav-item" href="/sources"><Database size={17} /><span>Tarama Geçmişi</span></Link><button className="nav-item"><Settings2 size={17} /><span>Ayarlar</span></button></nav>
        <div className="sidebar-footer"><div className="status-pulse"><span /> Tarama motoru aktif</div><div className="user-profile"><div className="avatar avatar-small">{session.name.slice(0, 2).toUpperCase()}</div><div><strong>{session.name}</strong><span>{session.role}</span></div><MoreHorizontal size={16} /></div></div>
      </aside>
      <main className="main-content">
        <header className="topbar"><div className="breadcrumb"><span>Panel</span><span>/</span><strong>Genel Bakış</strong></div><div className="topbar-actions"><button className="icon-button" aria-label="Yardım"><CircleHelp size={18} /></button><button className="icon-button notification" aria-label="Bildirimler"><Bell size={18} /><i /></button><div className="avatar">{session.name.slice(0, 2).toUpperCase()}</div></div></header>
        <div className="content-wrap">
          <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> {today}</div><h1>Merhaba, {session.name.split(" ")[0]} <span>✦</span></h1><p>Haber arşivlerinden yakalanan düşmüş domainlerin özeti.</p></div><Link className="primary-button" href="/sources"><Plus size={17} /> Yeni tarama başlat</Link></section>
          <section className="metric-grid"><article className="metric-card accent"><div className="metric-top"><span>ADAY DOMAIN</span><Radar size={17} /></div><strong>{number(candidateCount)}</strong><div className="metric-bottom"><span className="trend-up">{number(availableCount)}</span><span>hemen kayıt edilebilir</span></div></article><article className="metric-card"><div className="metric-top"><span>BU HAFTA YAKALANAN</span><Clock3 size={17} /></div><strong>{number(weeklyDropped)}</strong><div className="metric-bottom"><span>son 7 günde</span></div></article><article className="metric-card"><div className="metric-top"><span>TAKİP EDİLEN .COM</span><Globe2 size={17} /></div><strong>{number(trackedCount)}</strong><div className="metric-bottom"><span>haberlerden link alan domain</span></div></article><article className="metric-card"><div className="metric-top"><span>TARANAN SAYFA</span><FileText size={17} /></div><strong>{number(pagesScanned)}</strong><div className="metric-bottom"><span>{number(clientCount)} müşteri</span></div></article></section>
          <section className="section-block"><div className="section-heading"><div><h2>Son yakalanan domainler</h2><p>Kaynak sitelerden yeni yakalanan fırsatlar.</p></div><Link className="text-button" href="/domains">Tümünü gör <ArrowUpRight size={15} /></Link></div><div className="table-wrap"><table><thead><tr><th>DOMAIN</th><th>KAYNAK</th><th>LİNK</th><th>BİTİŞ</th><th>DURUM</th><th /></tr></thead><tbody>{latestCandidates.length === 0 ? <tr><td colSpan={6}>Henüz aday yok. Kaynak ekleyip tarama başlatın.</td></tr> : latestCandidates.map((item) => { const tone = availabilityTone[item.availability]; return <tr key={item.id}><td><strong className="domain-name">{item.name}</strong></td><td><span className="source-name">{item.dropped?.sourceSite.name ?? "-"}</span></td><td>{number(item.mentionCount)}</td><td>{item.expiresAt ? item.expiresAt.toLocaleDateString("tr-TR") : "-"}</td><td><span className={`status ${tone?.tone ?? ""}`}>{tone?.label ?? item.availability}</span></td><td><Link className="row-action" href={`/domains?q=${item.name}&status=${item.availability}`} aria-label={`${item.name} detayları`}><ExternalLink size={15} /></Link></td></tr>; })}</tbody></table></div></section>
          <div className="bottom-grid"><section className="section-block mini-section"><div className="section-heading"><div><h2>Müşteriler</h2><p>Son eklenenler.</p></div><button className="more-button" aria-label="Daha fazla"><MoreHorizontal size={18} /></button></div><div className="client-list">{clients.length === 0 ? <p className="empty-source">Henüz müşteri yok.</p> : clients.map((client, index) => <div className="client-row" key={client.id}><div className={`avatar client-avatar ${clientColors[index % clientColors.length]}`}>{client.name.slice(0, 2).toUpperCase()}</div><div className="client-info"><strong>{client.name}</strong><span>{client._count.assignments} domain</span></div><ArrowUpRight size={15} className="muted-icon" /></div>)}</div></section><section className="activity-card"><div className="section-heading"><div><h2>Tarama aktivitesi</h2><p>Son 7 günde yakalanan aday domainler.</p></div><Activity size={18} className="accent-icon" /></div><div className="chart-area"><div className="chart-label"><span>Yakalanan domain</span><strong>{number(weeklyDropped)}</strong></div><div className="bars">{days.map((day, index) => <div className="bar-column" key={index}><div className={`bar ${index === 6 ? "highlight" : ""}`} style={{ height: `${Math.max(4, (day.count / maxDay) * 100)}%` }} title={`${day.count}`} /><span>{day.label}</span></div>)}</div></div></section></div>
        </div>
      </main>
    </div>
  );
}
