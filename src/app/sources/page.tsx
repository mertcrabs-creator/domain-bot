"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Globe2, Plus, Radar } from "lucide-react";

type Source = {
  id: string;
  name: string;
  url: string;
  isActive: boolean;
  lastScanned: string | null;
  _count: { domains: number };
};

export default function SourcesPage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState("");
  const [scannedUrls, setScannedUrls] = useState<Record<string, string[]>>({});
  const [foundDomains, setFoundDomains] = useState<Record<string, string[]>>({});

  async function loadSources() {
    const response = await fetch("/api/sources");
    if (response.ok) setSources(await response.json());
  }

  useEffect(() => {
    let isMounted = true;
    void fetch("/api/sources")
      .then((response) => (response.ok ? response.json() : []))
      .then((data: Source[]) => {
        if (isMounted) setSources(data);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  async function addSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/api/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, url }),
    });
    const result = await response.json();
    if (!response.ok) {
      setMessage(result.error || "Kaynak eklenemedi.");
      return;
    }
    setName("");
    setUrl("");
    setMessage("Kaynak eklendi.");
    await loadSources();
  }

  async function scanSource(id: string) {
    setBusyId(id);
    setMessage("");
    setScannedUrls((current) => ({ ...current, [id]: [] }));
    const response = await fetch(`/api/sources/${id}/scan`, { method: "POST" });
    const result = await response.json();
    setMessage(response.ok
      ? `${result.pagesScanned} sayfa tarandı, ${result.linksFound} dış domain bulundu, ${result.created} yeni aday kaydedildi.`
      : result.error || "Tarama başarısız oldu.");
    if (response.ok) {
      setScannedUrls((current) => ({ ...current, [id]: result.scannedUrls ?? [] }));
      setFoundDomains((current) => ({ ...current, [id]: result.discoveredDomains ?? [] }));
    }
    setBusyId("");
    await loadSources();
  }

  return (
    <main className="sources-page">
      <div className="sources-wrap">
        <Link href="/" className="back-link"><ArrowLeft size={15} /> Panele dön</Link>
        <header className="sources-heading">
          <div>
            <p className="eyebrow">TARAMA MOTORU</p>
            <h1>Kaynak siteler</h1>
            <p>Haber sitelerini ekleyin, dış bağlantıları tarayın ve boşa düşen domain adaylarını yakalayın.</p>
          </div>
          <div className="source-summary"><Globe2 size={20} /><strong>{sources.length}</strong><span>aktif kaynak</span></div>
        </header>

        <section className="source-add-panel">
          <div><span className="panel-icon"><Plus size={18} /></span><div><h2>Yeni kaynak ekle</h2><p>Kaynağın ana sayfası veya taranacak kategori URL’si olabilir.</p></div></div>
          <form onSubmit={addSource} className="source-form">
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Kaynak adı (örn. TechCrunch)" required />
            <input value={url} onChange={(event) => setUrl(event.target.value)} type="url" placeholder="https://techcrunch.com" required />
            <button type="submit"><Plus size={16} /> Kaynak ekle</button>
          </form>
          {message ? <p className="source-message">{message}</p> : null}
        </section>

        <section className="source-list">
          <div className="source-list-heading"><div><h2>Kayıtlı kaynaklar</h2><p>Her kaynak için manuel tarama başlatabilirsiniz.</p></div><Radar size={19} className="accent-icon" /></div>
          {sources.length === 0 ? <div className="empty-source">Henüz kaynak eklenmedi.</div> : sources.map((source) => (
            <article className="source-row" key={source.id}>
              <div className="source-favicon"><Globe2 size={18} /></div>
              <div className="source-info"><strong>{source.name}</strong><a href={source.url} target="_blank" rel="noreferrer">{source.url} <ExternalLink size={12} /></a></div>
              <div className="source-stat"><strong>{source._count.domains}</strong><span>aday domain</span></div>
              <div className="source-stat"><strong>{source.lastScanned ? new Date(source.lastScanned).toLocaleDateString("tr-TR") : "-"}</strong><span>son tarama</span></div>
              <button className="scan-button" onClick={() => void scanSource(source.id)} disabled={busyId === source.id}><Radar size={15} />{busyId === source.id ? "Taranıyor..." : "Tara"}</button>
              {scannedUrls[source.id]?.length ? <details className="scanned-url-list"><summary>{scannedUrls[source.id].length} taranan URL’yi göster</summary><div>{scannedUrls[source.id].map((scannedUrl) => <a href={scannedUrl} key={scannedUrl} target="_blank" rel="noreferrer">{scannedUrl} <ExternalLink size={11} /></a>)}</div></details> : null}
              {foundDomains[source.id]?.length ? <details className="scanned-url-list found-domain-list"><summary>{foundDomains[source.id].length} bulunan domaini göster</summary><div>{foundDomains[source.id].map((domain) => <span key={domain}>{domain}</span>)}</div></details> : null}
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
