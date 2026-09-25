import { redirect } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Activity, ArrowUpRight, Bell, ChevronDown, CircleHelp, Clock3, Database, ExternalLink, Filter, Globe2, LayoutDashboard, ListFilter, MoreHorizontal, Plus, Radar, Search, Settings2, ShieldCheck, Users, WalletCards } from "lucide-react";
import { getSession } from "@/lib/auth";

const navItems = [
  { label: "Genel Bakış", icon: LayoutDashboard },
  { label: "Düşen Domainler", icon: Radar, count: "248" },
  { label: "Kaynak Siteler", icon: Globe2 },
  { label: "Müşteriler", icon: Users },
];

const domains = [
  { domain: "urbanframe.co", source: "TechCrunch", age: "12 yıl", da: "42", links: "86", price: "$2,400", status: "Yeni", tone: "new" },
  { domain: "velvetroom.com", source: "The Verge", age: "9 yıl", da: "38", links: "61", price: "$1,850", status: "İnceleniyor", tone: "review" },
  { domain: "northstar.io", source: "Product Hunt", age: "7 yıl", da: "35", links: "44", price: "$980", status: "Yeni", tone: "new" },
  { domain: "atlasjournal.net", source: "Wired", age: "14 yıl", da: "51", links: "129", price: "$3,200", status: "Atandı", tone: "assigned" },
];

const clients = [
  { initials: "AK", name: "Apex Kreatif", domains: "12 domain", value: "$18,450", color: "gold" },
  { initials: "NS", name: "North Studio", domains: "8 domain", value: "$11,290", color: "blue" },
  { initials: "MB", name: "Mavi Büyüme", domains: "5 domain", value: "$6,840", color: "red" },
];

export default async function Home() {
  const session = await getSession();

  if (!session || !session.fullAccess) {
    redirect("/login");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Image src="https://www.crabsmedia.com/wp-content/uploads/2025/02/logo.png" alt="Crabs Media" width={27} height={27} /></span><span>domain<span className="brand-dot">.</span>bot</span></div>
        <div className="workspace-switcher"><div><span className="workspace-label">ÇALIŞMA ALANI</span><strong>Crabs Media</strong></div><ChevronDown size={15} /></div>
        <nav className="nav-list" aria-label="Ana navigasyon"><span className="nav-section-label">PANEL</span>{navItems.map((item) => item.label === "Kaynak Siteler" ? <Link className="nav-item" href="/sources" key={item.label}><item.icon /><span>{item.label}</span></Link> : <button className="nav-item active" key={item.label}><item.icon /><span>{item.label}</span>{item.count && <b>{item.count}</b>}</button>)}<span className="nav-section-label">YÖNETİM</span><button className="nav-item"><Database size={17} /><span>Tarama Geçmişi</span></button><button className="nav-item"><Settings2 size={17} /><span>Ayarlar</span></button></nav>
        <div className="sidebar-footer"><div className="status-pulse"><span /> Tarama motoru aktif</div><div className="user-profile"><div className="avatar avatar-small">{session.name.slice(0, 2).toUpperCase()}</div><div><strong>{session.name}</strong><span>{session.role}</span></div><MoreHorizontal size={16} /></div></div>
      </aside>
      <main className="main-content">
        <header className="topbar"><div className="breadcrumb"><span>Panel</span><span>/</span><strong>Genel Bakış</strong></div><div className="topbar-actions"><button className="icon-button" aria-label="Yardım"><CircleHelp size={18} /></button><button className="icon-button notification" aria-label="Bildirimler"><Bell size={18} /><i /></button><div className="avatar">{session.name.slice(0, 2).toUpperCase()}</div></div></header>
        <div className="content-wrap">
          <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> 16 EYLÜL 2026, ÇARŞAMBA</div><h1>Günaydın, {session.name.split(" ")[0]} <span>✦</span></h1><p>Portföyünü büyütmek için bugün iyi bir gün.</p></div><button className="primary-button"><Plus size={17} /> Yeni tarama başlat</button></section>
          <section className="metric-grid"><article className="metric-card accent"><div className="metric-top"><span>TAKİP EDİLEN DOMAIN</span><Radar size={17} /></div><strong>1,284</strong><div className="metric-bottom"><span className="trend-up">+12.8%</span><span>geçen aya göre</span></div></article><article className="metric-card"><div className="metric-top"><span>BU HAFTA DÜŞEN</span><Clock3 size={17} /></div><strong>248</strong><div className="metric-bottom"><span className="trend-up">+32</span><span>son 7 günde</span></div></article><article className="metric-card"><div className="metric-top"><span>AKTİF MÜŞTERİ</span><Users size={17} /></div><strong>36</strong><div className="metric-bottom"><span className="trend-up">+4.2%</span><span>geçen aya göre</span></div></article><article className="metric-card"><div className="metric-top"><span>TOPLAM PORTFÖY DEĞERİ</span><WalletCards size={17} /></div><strong>$84.6K</strong><div className="metric-bottom"><span className="trend-up">+8.4%</span><span>tahmini değer</span></div></article></section>
          <section className="section-block"><div className="section-heading"><div><h2>Son düşen domainler</h2><p>Kaynak sitelerden yeni yakalanan fırsatlar.</p></div><button className="text-button">Tümünü gör <ArrowUpRight size={15} /></button></div><div className="filter-bar"><div className="search-box"><Search size={16} /><input placeholder="Domain ara..." /></div><button className="filter-button"><ListFilter size={16} /> Filtrele <span>3</span></button><button className="filter-button"><Filter size={16} /> Kaynak: Tümü <ChevronDown size={14} /></button></div><div className="table-wrap"><table><thead><tr><th>DOMAIN</th><th>KAYNAK</th><th>YAŞ</th><th>DA</th><th>BACKLINK</th><th>TAHMİNİ DEĞER</th><th>DURUM</th><th /></tr></thead><tbody>{domains.map((item) => <tr key={item.domain}><td><strong className="domain-name">{item.domain}</strong><span className="domain-meta"><ShieldCheck size={12} /> SSL uygun</span></td><td><span className="source-name">{item.source}</span></td><td>{item.age}</td><td><strong>{item.da}</strong></td><td>{item.links}</td><td><strong>{item.price}</strong></td><td><span className={`status ${item.tone}`}>{item.status}</span></td><td><button className="row-action" aria-label={`${item.domain} detayları`}><ExternalLink size={15} /></button></td></tr>)}</tbody></table></div></section>
          <div className="bottom-grid"><section className="section-block mini-section"><div className="section-heading"><div><h2>Aktif müşteriler</h2><p>Son atama özeti.</p></div><button className="more-button" aria-label="Daha fazla"><MoreHorizontal size={18} /></button></div><div className="client-list">{clients.map((client) => <div className="client-row" key={client.name}><div className={`avatar client-avatar ${client.color}`}>{client.initials}</div><div className="client-info"><strong>{client.name}</strong><span>{client.domains}</span></div><div className="client-value"><strong>{client.value}</strong><span>portföy</span></div><ArrowUpRight size={15} className="muted-icon" /></div>)}</div></section><section className="activity-card"><div className="section-heading"><div><h2>Tarama aktivitesi</h2><p>Son 7 günlük tarama performansı.</p></div><Activity size={18} className="accent-icon" /></div><div className="chart-area"><div className="chart-label"><span>Yakalanan domain</span><strong>248</strong></div><div className="bars">{[34, 54, 42, 75, 48, 88, 67].map((height, index) => <div className="bar-column" key={index}><div className={`bar ${index === 5 ? "highlight" : ""}`} style={{ height: `${height}%` }} /><span>{["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"][index]}</span></div>)}</div></div></section></div>
        </div>
      </main>
    </div>
  );
}
