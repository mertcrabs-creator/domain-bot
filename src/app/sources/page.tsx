"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, FileCode2, Globe2, Play, Plus, Radar, Square, Trash2 } from "lucide-react";

type ScanJob = {
  id: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  batch: number | null;
  phase: string;
  pagesTotal: number;
  pagesDone: number;
  pagesFailed: number;
  domainsFound: number;
  mentionsFound: number;
  lastMessage: string | null;
  error: string | null;
  createdAt: string;
  heartbeatAt: string | null;
  waitingForWorker: boolean;
};

type Source = {
  id: string;
  name: string;
  url: string;
  mode: "SITEMAP" | "CRAWL";
  isActive: boolean;
  lastScanned: string | null;
  sitemapUrls: string[];
  candidateCount: number;
  latestJob: ScanJob | null;
  batches: PageBatch[];
};

type PageBatch = { number: number; pagesTotal: number; pagesDone: number; pagesFailed: number };

const phaseLabels: Record<string, string> = {
  waiting: "Worker bekleniyor",
  discovering: "Sitemap okunuyor",
  splitting: "Parçalara bölünüyor",
  crawling: "Sayfalar taranıyor",
  checking: "Domainler kontrol ediliyor",
  done: "Tamamlandı",
};

const statusLabels: Record<ScanJob["status"], string> = {
  QUEUED: "Sırada",
  RUNNING: "Çalışıyor",
  COMPLETED: "Tamamlandı",
  FAILED: "Hata",
  CANCELLED: "Durduruldu",
};

const isActiveJob = (job: ScanJob | null) => job?.status === "QUEUED" || job?.status === "RUNNING";
const number = (value: number) => value.toLocaleString("tr-TR");
// Sitemap sources only read their sitemaps with this button; the pages are crawled batch by batch.
const scanLabel = (source: Source) => (source.mode === "CRAWL" ? "Tara" : source.batches.length > 0 ? "Sitemap'leri yenile" : "Sitemap'leri oku");

function JobProgress({ job, onCancel }: { job: ScanJob; onCancel: () => void }) {
  const processed = job.pagesDone + job.pagesFailed;
  const percent = job.pagesTotal > 0 ? Math.min(100, Math.round((processed / job.pagesTotal) * 100)) : 0;

  return (
    <div className={`job-progress job-${job.status.toLowerCase()}`}>
      <div className="job-progress-head">
        <span className="job-status">
          {job.batch !== null ? `Parça ${job.batch} · ` : ""}
          {statusLabels[job.status]}{job.status === "RUNNING" ? ` · ${phaseLabels[job.phase] ?? job.phase}` : ""}
        </span>
        <span>{number(processed)} / {number(job.pagesTotal)} sayfa · {number(job.domainsFound)} .com domain · {number(job.mentionsFound)} link</span>
        {isActiveJob(job) ? <button type="button" className="job-cancel" onClick={onCancel}><Square size={11} /> Durdur</button> : null}
      </div>
      {job.status === "RUNNING" || job.status === "QUEUED" ? <div className="job-bar"><i style={{ width: `${percent}%` }} /></div> : null}
      {job.waitingForWorker ? <p className="job-note">Worker çalışmıyor olabilir. Ayrı bir terminalde <code>npm run worker</code> komutunu çalıştırın.</p> : null}
      {job.error ? <p className="job-note job-error">{job.error}</p> : job.lastMessage ? <p className="job-note">{job.lastMessage}</p> : null}
    </div>
  );
}

function BatchList({ source, onStart }: { source: Source; onStart: (batch: number) => void }) {
  const activeJob = isActiveJob(source.latestJob) ? source.latestJob : null;

  return (
    <div className="batch-list">
      <div className="batch-list-head">
        <strong>Parçalar</strong>
        <span>{source.batches.length} parça · her biri en fazla 50.000 URL · en eski makaleler ilk parçada</span>
      </div>
      {source.batches.map((batch) => {
        // The running batch shows the job's live counters; the others show what was saved when they last ran.
        const running = activeJob?.batch === batch.number;
        const done = running ? activeJob.pagesDone : batch.pagesDone;
        const failed = running ? activeJob.pagesFailed : batch.pagesFailed;
        const processed = done + failed;
        const finished = batch.pagesTotal > 0 && processed >= batch.pagesTotal;
        const percent = batch.pagesTotal > 0 ? Math.min(100, Math.round((processed / batch.pagesTotal) * 100)) : 0;
        return (
          <div className={`batch-row${running ? " batch-running" : ""}`} key={batch.number}>
            <span className="batch-name">Parça {batch.number}</span>
            <span className="batch-count">{number(processed)} / {number(batch.pagesTotal)} URL{failed > 0 ? ` · ${number(failed)} hata` : ""}</span>
            <div className="job-bar"><i style={{ width: `${percent}%` }} /></div>
            <button type="button" className="batch-start" disabled={Boolean(activeJob) || finished} onClick={() => onStart(batch.number)}>
              <Play size={11} />
              {running ? "Taranıyor" : finished ? "Bitti" : processed > 0 ? "Devam et" : "Başlat"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function SitemapEditor({ source, onSaved, onClose }: { source: Source; onSaved: (message: string) => Promise<void>; onClose: () => void }) {
  const [text, setText] = useState(source.sitemapUrls.join("\n"));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const response = await fetch(`/api/sources/${source.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sitemapUrls: text }),
    });
    setSaving(false);
    if (!response.ok) {
      setError((await response.json().catch(() => null))?.error || "Sitemap'ler kaydedilemedi.");
      return;
    }
    onClose();
    await onSaved(text.trim() ? `"${source.name}" için sitemap'ler kaydedildi. Bir sonraki tarama bu linklerden başlayacak.` : `"${source.name}" için sitemap'ler yeniden otomatik bulunacak.`);
  }

  return (
    <form className="sitemap-editor" onSubmit={save}>
      <label htmlFor={`sitemaps-${source.id}`}>Manuel sitemap linkleri</label>
      <p>Her satıra bir link yazın. Sitemap index, normal sitemap, .xml.gz, RSS veya düz metin olabilir. Link girilirse otomatik arama yapılmaz; boş bırakırsanız sitemap&apos;ler yine otomatik aranır.</p>
      <textarea
        id={`sitemaps-${source.id}`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={4}
        placeholder={`${new URL(source.url).origin}/sitemap-index.xml`}
        spellCheck={false}
      />
      {error ? <p className="job-note job-error">{error}</p> : null}
      <div className="sitemap-editor-actions">
        <button type="button" className="job-cancel" onClick={onClose}>Vazgeç</button>
        <button type="submit" className="scan-button" disabled={saving}>{saving ? "Kaydediliyor..." : "Kaydet"}</button>
      </div>
    </form>
  );
}

export default function SourcesPage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<Source["mode"]>("SITEMAP");
  const [message, setMessage] = useState("");
  const [editingSitemaps, setEditingSitemaps] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    const response = await fetch("/api/sources");
    if (response.ok) setSources(await response.json());
  }, []);

  useEffect(() => {
    // Initial load; setState happens after the fetch resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSources();
  }, [loadSources]);

  const hasActiveJob = sources.some((source) => isActiveJob(source.latestJob));
  useEffect(() => {
    if (!hasActiveJob) return;
    // The worker writes job progress every ~10s, so polling faster only adds DB load.
    const timer = setInterval(() => void loadSources(), 5000);
    return () => clearInterval(timer);
  }, [hasActiveJob, loadSources]);

  async function addSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/api/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, url, mode }),
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

  async function startScan(id: string, batch?: number) {
    setMessage("");
    const response = await fetch(`/api/sources/${id}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch === undefined ? {} : { batch }),
    });
    if (!response.ok) setMessage((await response.json()).error || "Tarama başlatılamadı.");
    await loadSources();
  }

  async function cancelScan(jobId: string) {
    await fetch(`/api/scans/${jobId}/cancel`, { method: "POST" });
    await loadSources();
  }

  async function deleteSource(source: Source) {
    if (!window.confirm(`"${source.name}" kaynağı, taranan sayfaları ve bulunan linkleriyle birlikte silinsin mi?`)) return;
    const response = await fetch(`/api/sources/${source.id}`, { method: "DELETE" });
    if (response.ok) setMessage(`"${source.name}" silindi; sayfaları ve linkleri arka planda temizleniyor.`);
    else setMessage((await response.json().catch(() => null))?.error || "Kaynak silinemedi.");
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
            <p>Haber sitelerini ekleyin, arşivdeki dış bağlantıları tarayın ve boşa düşen .com domainleri yakalayın. <Link href="/domains" className="inline-link">Bulunan domainler →</Link></p>
          </div>
          <div className="source-summary"><Globe2 size={20} /><strong>{sources.length}</strong><span>kaynak</span></div>
        </header>

        <section className="source-add-panel">
          <div><span className="panel-icon"><Plus size={18} /></span><div><h2>Yeni kaynak ekle</h2><p>Tüm arşiv: sitenin sitemap’leri okunur, URL’ler 50.000’lik parçalara bölünür ve parçaları tek tek başlatırsınız. Site içi tarama: verilen URL’den başlayıp 3 tık derinliğe kadar gezilir.</p></div></div>
          <form onSubmit={addSource} className="source-form">
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Kaynak adı (örn. TechCrunch)" required />
            <input value={url} onChange={(event) => setUrl(event.target.value)} type="url" placeholder="https://techcrunch.com" required />
            <select value={mode} onChange={(event) => setMode(event.target.value as Source["mode"])} aria-label="Tarama modu">
              <option value="SITEMAP">Tüm arşiv (sitemap)</option>
              <option value="CRAWL">Site içi tarama</option>
            </select>
            <button type="submit"><Plus size={16} /> Kaynak ekle</button>
          </form>
          {message ? <p className="source-message">{message}</p> : null}
        </section>

        <section className="source-list">
          <div className="source-list-heading"><div><h2>Kayıtlı kaynaklar</h2><p>Taramalar arka planda çalışır; sayfayı kapatabilirsiniz. Yeniden tarama sadece yeni sayfaları işler.</p></div><Radar size={19} className="accent-icon" /></div>
          {sources.length === 0 ? <div className="empty-source">Henüz kaynak eklenmedi.</div> : sources.map((source) => (
            <article className="source-row" key={source.id}>
              <div className="source-favicon"><Globe2 size={18} /></div>
              <div className="source-info">
                <strong>
                  {source.name} <span className="mode-tag">{source.mode === "SITEMAP" ? "Tüm arşiv" : "Site içi"}</span>
                  {source.mode === "SITEMAP" && source.sitemapUrls.length > 0 ? <span className="mode-tag">{source.sitemapUrls.length} manuel sitemap</span> : null}
                </strong>
                <a href={source.url} target="_blank" rel="noreferrer">{source.url} <ExternalLink size={12} /></a>
              </div>
              <Link className="source-stat" href={`/domains?source=${source.id}`}><strong>{number(source.candidateCount)}</strong><span>aday domain</span></Link>
              <div className="source-stat"><strong>{source.lastScanned ? new Date(source.lastScanned).toLocaleDateString("tr-TR") : "-"}</strong><span>son tarama</span></div>
              <div className="source-actions">
                <button className="scan-button" onClick={() => void startScan(source.id)} disabled={isActiveJob(source.latestJob)}><Radar size={15} />{isActiveJob(source.latestJob) ? "Taranıyor" : scanLabel(source)}</button>
                {source.mode === "SITEMAP" ? (
                  <button
                    className="icon-button"
                    onClick={() => setEditingSitemaps(editingSitemaps === source.id ? null : source.id)}
                    aria-label={`${source.name} sitemap linklerini düzenle`}
                    title="Manuel sitemap linkleri"
                  >
                    <FileCode2 size={14} />
                  </button>
                ) : null}
                <button className="icon-danger" onClick={() => void deleteSource(source)} aria-label={`${source.name} kaynağını sil`}><Trash2 size={14} /></button>
              </div>
              {editingSitemaps === source.id ? (
                <SitemapEditor
                  source={source}
                  onClose={() => setEditingSitemaps(null)}
                  onSaved={async (text) => {
                    setMessage(text);
                    await loadSources();
                  }}
                />
              ) : null}
              {source.latestJob ? <JobProgress job={source.latestJob} onCancel={() => void cancelScan(source.latestJob!.id)} /> : null}
              {source.batches.length > 0 ? <BatchList source={source} onStart={(batch) => void startScan(source.id, batch)} /> : null}
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
