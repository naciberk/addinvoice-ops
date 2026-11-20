// Ayarlar (tuning) sayfasının veri tanımı: her ayarın HEDEF değeri ve NEDEN o değerde olduğu.
// Hedef = bilinçli seçilmiş değer (docs/ops-postgres.md §5). Canlı değer hedeften farklıysa sayfada sarı görünür.

export type Item = { key: string; label: string; target: string; why: string; dedicated?: string; equiv?: string[] }

export const PG_ITEMS: Item[] = [
  { key: "shared_buffers", label: "Paylaşılan bellek önbelleği", target: "3GB", dedicated: "12GB", why: "PostgreSQL'in kendi disk önbelleği. RAM'in ~%25'i: 12 GB'lık sunucuda uygulama ve nginx de çalıştığı için 3 GB. Daha büyük = daha az disk okuma; fazlası işletim sisteminin önbelleğiyle yarışır." },
  { key: "effective_cache_size", label: "Önbellek tahmini (planlayıcıya ipucu)", target: "8GB", dedicated: "34GB", why: "Bellek AYIRMAZ; yalnız 'işletim sistemi + PostgreSQL toplam ne kadar veriyi önbellekte tutabilir' bilgisini planlayıcıya verir. Yüksek olması indeks kullanımını teşvik eder." },
  { key: "work_mem", label: "Sorgu başına sıralama/hash belleği", target: "32MB", dedicated: "64MB", why: "Her sıralama/birleştirme adımı bu kadar bellek kullanabilir. Düşükse geçici dosyaya taşar (yavaş). Çok yüksek olursa eşzamanlı sorgularla bellek taşar — havuz 20 bağlantı olduğundan 32 MB güvenli." },
  { key: "maintenance_work_mem", label: "Bakım işleri belleği", target: "512MB", dedicated: "2GB", why: "VACUUM, CREATE INDEX, REINDEX için. Büyükse bu işlemler daha hızlı biter." },
  { key: "autovacuum_work_mem", label: "Autovacuum işçisi başına bellek", target: "256MB", why: "4 autovacuum işçisi var; her biri maintenance_work_mem (512 MB) kullanırsa 2 GB'a çıkardı. 256 MB ile sınırlı ve yeterli." },
  { key: "random_page_cost", label: "Rastgele disk okuma maliyeti", target: "1.1", dedicated: "1.1", why: "SSD'de rastgele okuma ardışıktan neredeyse pahalı değildir (varsayılan 4 = döner disk). 1.1 planlayıcıyı indeks kullanmaya yöneltir." },
  { key: "effective_io_concurrency", label: "Eşzamanlı disk isteği", target: "200", dedicated: "200", why: "SSD aynı anda çok okumayı kaldırır; bitmap taramalar buna göre önden okur." },
  { key: "jit", label: "JIT derleme", target: "off", why: "Çok ağır analitik sorgularda işe yarar; kısa OLTP/rapor sorgularında derleme süresi kazancı aşar ve öngörülemez yavaşlık yaratır. Kapalı tutmak daha kararlı." },
  { key: "wal_compression", label: "WAL sıkıştırma", target: "on", equiv: ["pglz", "lz4", "zstd"], dedicated: "on", why: "WAL yazımını küçültür → daha az disk G/Ç, daha küçük yedek arşivi. CPU maliyeti ihmal edilebilir." },
  { key: "max_wal_size", label: "Checkpoint arası WAL üst sınırı", target: "4GB", dedicated: "16GB", why: "Yüksek olması checkpoint'leri seyreltir (daha az G/Ç dalgalanması). Çökmede kurtarma süresi biraz uzar ama bu veri boyutunda saniyelerdir." },
  { key: "checkpoint_timeout", label: "Azami checkpoint aralığı", target: "15min", dedicated: "15min", why: "Checkpoint'ler arası süre. Uzun aralık = daha az yazma, daha yumuşak performans." },
  { key: "checkpoint_completion_target", label: "Checkpoint yayma oranı", target: "0.9", dedicated: "0.9", why: "Checkpoint yazımını aralığın %90'ına yayar → G/Ç sivrilmesi olmaz." },
  { key: "archive_mode", label: "WAL arşivleme", target: "on", dedicated: "on", why: "PITR'nin temeli: her WAL dosyası pgBackRest deposuna kopyalanır. KAPATMA." },
  { key: "archive_timeout", label: "WAL'ı en geç şu sürede arşivle", target: "5min", dedicated: "5min", why: "Hareketsiz olsa bile her 5 dakikada WAL arşive atılır → olası veri kaybı penceresi ≤ 5 dk." },
  { key: "max_parallel_workers_per_gather", label: "Sorgu başına paralel işçi", target: "2", dedicated: "4", why: "Büyük taramalar birden çok çekirdekten faydalanır; 6 çekirdekte 2 makul (uygulama da çekirdek kullanıyor)." },
  { key: "autovacuum_max_workers", label: "Autovacuum işçi sayısı", target: "4", dedicated: "6", why: "Aynı anda temizlenebilen tablo sayısı. Çok tablolu şemada (127 tablo) 3 varsayılandan fazlası bekleme yaratmaz." },
  { key: "autovacuum_naptime", label: "Autovacuum uyanma aralığı", target: "30s", dedicated: "30s", why: "Varsayılan 1 dk; 30 sn ile ölü satır birikmeden temizlenir." },
  { key: "autovacuum_vacuum_scale_factor", label: "VACUUM tetikleme oranı", target: "0.05", dedicated: "0.05", why: "Varsayılan %20 yerine tablonun %5'i ölü olunca temizle → şişme (bloat) oluşmaz, MySQL'deki defrag ihtiyacını önler." },
  { key: "autovacuum_vacuum_cost_limit", label: "Autovacuum hız sınırı", target: "1000", dedicated: "2000", why: "Varsayılan 200 çok yavaş; SSD'de 1000 ile temizlik yetişir, kullanıcı sorgularını yine de boğmaz." },
  { key: "idle_in_transaction_session_timeout", label: "Açık bırakılmış işlem zaman aşımı", target: "10min", why: "Bir işlem açık kalıp hiçbir şey yapmazsa kilit tutar ve VACUUM'u engeller. 10 dk sonra otomatik kapatılır; uygulama işlemleri saniyeler sürer." },
  { key: "tcp_keepalives_idle", label: "TCP canlılık denetimi (boşta)", target: "60s", equiv: ["60"], why: "Ağ kopan/ölen istemci bağlantısını dakikalar içinde fark edip kaynakları serbest bırakır. (Yerel soketten bakınca 0 görünür; TCP bağlantılarında 60 sn'dir.)" },
  { key: "log_min_duration_statement", label: "Yavaş sorgu günlüğü eşiği", target: "500ms", dedicated: "500ms", why: "500 ms'den uzun süren her sorgu PostgreSQL günlüğüne yazılır → yavaşlığı sonradan inceleyebilirsin." },
  { key: "track_io_timing", label: "G/Ç süresi ölçümü", target: "on", dedicated: "on", why: "Hangi sorgunun diskte ne kadar beklediğini ölçer; ihmal edilebilir maliyet." },
  { key: "synchronous_commit", label: "Commit'te diske yazma onayı", target: "on", why: "BİLEREK AÇIK: muhasebe verisinde 'kaydedildi' dediğimiz an diskte olmalı. Kapatmak hız kazandırır ama çökmede son işlemleri kaybettirir." },
  { key: "max_connections", label: "Azami doğrudan bağlantı", target: "100", why: "Uygulama pgBouncer üzerinden 20 bağlantıyla çalışır; 100 bakım/izleme/yedek için bol bol yeter. Artırmak gereksiz bellek harcar." },
]

export const PGB_ITEMS: Item[] = [
  { key: "pool_mode", label: "Havuz modu", target: "transaction", why: "Bağlantı yalnız bir işlem süresince ödünç alınır → 1000 istemci 20 gerçek bağlantıyla yönetilir. (Prisma için ?pgbouncer=true gerekir.)" },
  { key: "default_pool_size", label: "Veritabanı başına gerçek bağlantı", target: "20", why: "6 çekirdekte 20 eşzamanlı sorgu zaten doyum noktasıdır; fazlası yalnız bekleme/bağlam değiştirme yaratır." },
  { key: "min_pool_size", label: "Sıcak tutulan en az bağlantı", target: "5", why: "Trafik azken bile 5 bağlantı açık kalır → sabah ilk istek bağlantı kurma gecikmesi yaşamaz." },
  { key: "reserve_pool_size", label: "Taşma yedeği", target: "5", why: "Ani yük patlamasında havuza 5 ek bağlantı izni." },
  { key: "max_client_conn", label: "Azami istemci bağlantısı", target: "1000", why: "Uygulama kopyalarının tüm bağlantılarını karşılayacak kadar yüksek; çok kopya (cluster) olsa da yeter." },
  { key: "server_idle_timeout", label: "Boşta bağlantı ömrü", target: "600", why: "Kullanılmayan PostgreSQL bağlantıları 10 dakika sonra kapanır; min_pool_size kadarı korunur." },
  { key: "query_wait_timeout", label: "Havuz doluyken azami bekleme", target: "60", why: "Havuz tıkandığında istek sonsuza dek asılı kalmaz; 60 sn sonra hata verir ve sorun görünür olur." },
  { key: "log_connections", label: "Bağlantı açılışını günlüğe yaz", target: "0", why: "Her bağlantı için log satırı yazmak G/Ç ve gürültüdür; kapalı." },
]

export const NGINX_ITEMS: Item[] = [
  { key: "worker_processes", label: "İşçi süreç sayısı", target: "auto", why: "CPU çekirdeği kadar (6). nginx işi hafiftir; auto doğru ayar." },
  { key: "worker_connections", label: "İşçi başına bağlantı", target: "4096", why: "Eskiden 768'di. Toplam eşzamanlı bağlantı = işçi × bu değer; 4096 ile ani trafik/yavaş istemciler kapıda bekletilmez." },
  { key: "worker_rlimit_nofile", label: "Açık dosya sınırı", target: "65535", why: "Her bağlantı bir dosya tanıtıcısı kullanır; worker_connections'ın karşılanması için gerekli üst sınır." },
  { key: "gzip", label: "gzip sıkıştırma", target: "on", why: "Metin yanıtları (JSON, JS, CSS, SVG) %70-80 küçülür. (Cloudflare ayrıca brotli yapar; originden de sıkıştırmak CF olmayan isteklerde işe yarar.)" },
  { key: "gzip_comp_level", label: "gzip seviyesi", target: "5", why: "1-9 arası: 5, CPU maliyeti ile küçülme arasındaki tatlı nokta (9 çok az kazandırır, çok CPU yer)." },
  { key: "gzip_min_length", label: "En küçük sıkıştırılan yanıt", target: "1024", why: "1 KB'tan küçük yanıtları sıkıştırmak kazanç değil kayıp." },
  { key: "gzip_types", label: "Sıkıştırılan türler", target: "text/plain text/css text/xml text/javascript application/json application/javascript application/xml application/xml+rss image/svg+xml", why: "Varsayılan yalnız text/html'dir; JSON/JS/CSS/SVG listeye eklenince sayfa API'leri de sıkışır." },
  { key: "upstream_keepalive", label: "Uygulamaya kalıcı bağlantı", target: "32", why: "nginx → Next.js arasındaki bağlantılar her istekte yeniden kurulmak yerine yeniden kullanılır (addinvoice.dk sitesi)." },
  { key: "server_tokens", label: "Sürüm bilgisi", target: "off", why: "Hata sayfalarında nginx sürümünü gizler (bilgi sızdırmama)." },
  { key: "client_max_body_size", label: "Azami yükleme boyutu", target: "20M", why: "Genel sınır 20 MB; addinvoice.dk sitesinde bilag/PDF yüklemeleri için 200 MB'a çıkarılmıştır (site dosyasında)." },
]

export const SYSCTL_ITEMS: Item[] = [
  { key: "net.core.somaxconn", label: "Dinleme kuyruğu uzunluğu", target: "4096", why: "nginx'in kabul bekleyen bağlantı kuyruğu; ani trafikte bağlantı reddini önler." },
  { key: "net.ipv4.tcp_max_syn_backlog", label: "SYN kuyruğu", target: "4096", why: "Yeni bağlantı isteklerinin (el sıkışma) bekleme kuyruğu; 1024'ten yükseltildi." },
  { key: "vm.swappiness", label: "Swap eğilimi", target: "10", why: "Çekirdek RAM'deki PostgreSQL/uygulama belleğini diske atmaya (swap) isteksiz olsun → öngörülebilir hız." },
  { key: "vm.dirty_background_ratio", label: "Arka plan yazma eşiği", target: "5", why: "Kirli sayfalar RAM'in %5'ini geçince arka planda diske yazılmaya başlanır → büyük ani yazma bloğu oluşmaz." },
  { key: "vm.dirty_ratio", label: "Zorunlu yazma eşiği", target: "15", why: "Bu orana varılırsa yazan süreçler beklemeye alınır; düşük tutmak uzun donmaları önler." },
]

export const HISTORY: { date: string; title: string; items: string[] }[] = [
  {
    date: "26 Ekim 2026 (1)", title: "İlk veritabanı tuning'i + PITR",
    items: ["PostgreSQL 12 GB profil: shared_buffers 3 GB, effective_cache_size 8 GB, work_mem 32 MB, random_page_cost 1.1, WAL sıkıştırma, checkpoint ayarları, paralel işçiler.", "Agresif autovacuum (scale_factor 0.05, naptime 30 sn, 4 işçi) + 25 büyük tabloda tablo bazlı eşikler.", "pgBackRest: WAL arşivi (PITR), haftalık tam + günlük fark yedek; geri yükleme testi yapıldı.", "6 eksik company_id indeksi eklendi; audit_logs aylık bölümlendi.", "vm.swappiness=10, dirty ratio'lar; haftalık sağlık raporu."],
  },
  {
    date: "26 Ekim 2026 (2)", title: "Hız + kararlılık eki (ops konsolundan bağımsız, yapılandırma yedekleriyle)",
    items: ["PostgreSQL: jit=off, idle_in_transaction_session_timeout=10min, TCP keepalive, autovacuum_work_mem=256MB.", "pgBouncer: min_pool_size=5, server_idle_timeout=600, query_wait_timeout=60, bağlantı günlüğü kapalı.", "nginx: worker_connections 768→4096, worker_rlimit_nofile 65535, gzip türleri/seviye, server_tokens off; addinvoice.dk için upstream keepalive 32.", "Çekirdek: tcp_max_syn_backlog 1024→4096.", "Hazır, kullanıcının çalıştırmasını bekliyor: pm2 cluster (3 instance) — ecosystem.config.cjs; ayrıca instrumentation.ts'e ayar yeniden eşitleme (build gerekir)."],
  },
]

export const APP_NOTE = `Ana uygulama şu an TEK Node süreci olarak çalışır (pm2 fork). 6 çekirdeğin yalnız biri kullanılır ve ağır bir istek (AI tarama, PDF, büyük rapor) o sürecin tüm kullanıcılarını bekletir.
Cluster modunda (3 instance) istekler 3 süreç arasında dağılır. Geçişten önce kodda şunlar kontrol edildi:
• Zamanlanmış işler uygulama içinde değil, cron + HTTP (curl localhost:7331/api/internal/…) ile tetiklenir → her tetikleme tek instance'a düşer, çift çalışma olmaz.
• Bellekte tutulan durum yalnız kısa ömürlü önbellekler (30 sn TTL).
• TEK risk: yöneticinin kaydettiği sistem ayarları (AI anahtarları, Stripe modu) process.env'e yazılıyordu → yalnız isteği işleyen instance güncellenirdi. instrumentation.ts'e her instance'ın ayarları dakikada bir yeniden okuması eklendi (build gerekir).
• 'npm start' içindeki 'prisma migrate deploy' cluster'da her instance'ta çalışmasın diye ecosystem.config.cjs doğrudan 'next start' kullanır; migrate yayın komutunda bir kez çalışır.`
