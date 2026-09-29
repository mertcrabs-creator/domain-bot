# domain.bot

Haber sitelerinin arşivlerini tarar, makalelerdeki dış linklerden **.com** domainleri toplar ve Verisign RDAP üzerinden kaydı düşmüş / düşmek üzere olanları bulur.

## Kurulum

```powershell
npm install
npx playwright install chromium   # engelleyen siteler için headless tarayıcı
```

`.env`:

```env
DATABASE_URL="postgresql://..."
SCANNER_MAX_PAGES=2000     # bir tarama çalıştırmasında işlenecek max sayfa (0 = limitsiz)
SCANNER_CONCURRENCY=4      # opsiyonel, aynı anda çekilen sayfa sayısı
```

```powershell
npx prisma migrate deploy
npm run db:generate
npm run db:seed-admins
```

## Çalıştırma

İki ayrı terminal gerekir:

```powershell
npm run dev      # web arayüzü → http://localhost:3000
npm run worker   # tarama ve domain kontrol işçisi
```

Taramalar web isteği içinde değil, worker'da çalışır. Worker kapanırsa yarım kalan tarama bir sonraki açılışta kaldığı yerden devam eder. Aynı anda tek bir worker çalıştırın.

## Yayına alma

Web arayüzü **Vercel**'de, worker **Railway**'de çalışır; ikisi yalnızca aynı PostgreSQL'i paylaşır.

1. **Veritabanı** — Neon / Supabase / Railway Postgres. Bir kere:
   ```powershell
   $env:DATABASE_URL="..."; npx prisma migrate deploy; npm run db:seed-admins
   ```
2. **Vercel (site)** — Repoyu import et, `DATABASE_URL` ekle (Neon/Supabase'de *pooled* bağlantı adresini kullan).
3. **Railway (worker)** — Aynı repodan servis oluştur. `railway.json` sayesinde `Dockerfile.worker` ile build edilir (Playwright + Chromium hazır gelir). Env: `DATABASE_URL`, isteğe bağlı `SCANNER_MAX_PAGES`, `SCANNER_CONCURRENCY`. En az ~1 GB RAM. Replica sayısı **1** kalmalı.

`playwright` paketini güncellerken `Dockerfile.worker`'daki image etiketini de aynı sürüme çek.

## Nasıl çalışır

1. **Keşif** — *Tüm arşiv* modunda `robots.txt` / `sitemap.xml` üzerinden bütün makale URL'leri `SourcePage` tablosuna yazılır (tag/kategori/yazar sayfaları elenir). *Site içi* modda verilen URL'den başlayıp site içinde 3 tık derinliğe kadar gezilir.
2. **Tarama** — Sayfalar en eskiden başlayarak çekilir (ölü linkler eski haberlerde yoğunlaşır). Engellenen isteklerde Playwright'a düşülür. Sadece makale gövdesindeki linkler alınır; menü, footer, ilgili haberler vb. dışarıda kalır.
3. **Domain** — Linkler kayıt edilebilir domaine indirgenir (`blog.ornek.com` → `ornek.com`), sadece `.com` tutulur, büyük platformlar elenir. Her link, kaynak makale, anchor text ve `rel` ile `DomainMention` olarak saklanır.
4. **Kontrol** — Worker her domaini RDAP'ta sorgular:
   - `AVAILABLE` — kayıt yok, hemen alınabilir
   - `PENDING_DELETE` — ~5 gün içinde düşecek
   - `REDEMPTION` — silinmiş, sahibi geri alabilir
   - `EXPIRING` — süresi dolmuş/dolmak üzere ya da askıda (hold)
   - `REGISTERED` — kayıtlı

   Adaylar düzenli olarak yeniden kontrol edilir (müsait: 24 saat, pendingDelete: 12 saat, kayıtlı: 30 gün).

Sonuçlar `/domains` sayfasında durum, kaynak ve link sayısına göre filtrelenir; her domainin altında onu linkleyen haberler listelenir.
