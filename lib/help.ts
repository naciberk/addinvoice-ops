import type { Role } from "./store"

export type HelpEntry = {
  id: string
  group: string
  title: string
  /** Ne işe yarar (1-2 cümle) */
  what: string
  /** Tıklarsan tam olarak ne olur */
  happens: string[]
  /** Dikkat edilecekler */
  caution: string[]
  /** Geri alınabilir mi / nasıl */
  undo: string
  role: Role
}

export const HELP_GROUPS = [
  { id: "genel", title: "Genel bakış ve uyarılar" },
  { id: "yedek", title: "Yedekler" },
  { id: "dis-yedek", title: "Dış yedekleme (borg: görevler ve hedefler)" },
  { id: "db", title: "Veritabanı" },
  { id: "sirket", title: "Şirketler" },
  { id: "servis", title: "Servisler ve günlükler" },
  { id: "config", title: "Yapılandırma düzenleme" },
  { id: "kullanici", title: "Kullanıcılar ve denetim" },
  { id: "tuning", title: "Ayarlar (tuning) sayfası" },
] as const

export const HELP: HelpEntry[] = [
  // ───────── Genel ─────────
  {
    id: "overview", group: "genel", title: "Genel bakış sayfası", role: "viewer",
    what: "Sunucunun ve veritabanının anlık sağlığı: CPU, bellek, disk, bağlantılar, son yedek, servis durumu ve haftalık sağlık raporunun uyarıları.",
    happens: ["Sayfa her açıldığında canlı okur; hiçbir şeyi değiştirmez.", "Kırmızı kutu, dikkat gerektiren durumları listeler (disk > %85, son yedek 36 saatten eski, çalışmayan servis, WAL arşiv hatası, transaction ID yaşı yüksek…)."],
    caution: ["'Her şey yolunda' yeşil kutusu yalnız burada ölçülenleri kapsar; yedek deposunun aynı diskte olması gibi mimari riskler ayrıca yazılıdır."],
    undo: "Salt okunur — geri alınacak bir şey yok.",
  },
  {
    id: "watchdog", group: "genel", title: "Bağımsız izleyici (e-posta + SMS uyarısı)", role: "viewer",
    what: "Sunucuda 15 dakikada bir çalışan, ana uygulamadan BAĞIMSIZ bir denetçi: servisler, pgBouncer ayar dosyası, veritabanı, uygulama HTTP, pm2 çökme döngüsü, build klasörü, tanıtım sitesi, dışarıdan görünen adresler ve disk.",
    happens: ["Bir denetim başarısız olursa 60 sn sonra yalnız o denetim bir kez daha denenir; ikisi de başarısızsa sorun 'teyitli' sayılır (anlık dalgalanmada alarm yok).", "Yeni teyitli sorun → e-posta (alert@ / ADMIN_EMAIL). 'Kritik' ise (uygulama/site 200 dönmüyor, veritabanı, ana servisler) ayrıca kısa SMS gider. Sorun sürerse e-posta 6 saatte bir, SMS 3 saatte bir hatırlatılır; düzelince 'normale döndü'.", "'Uyarı düzeyi' denetimler (ör. pgBouncer ayarında yorum hatası, disk > %90, build klasörü) yalnız e-posta gönderir; bunlar henüz kesinti değil ama bir sonraki yeniden başlatmada kesintiye yol açabilir."],
    caution: ["Hiç sonuç yazılmıyorsa (cron durduysa) izleyici KENDİ başına haber veremez — bu sayfa kırmızı uyarı gösterir; sunucunun tamamen kapanmasına karşı dış bir 'uptime' servisi ayrıca gerekir.", "Alıcı numara/e-posta: /etc/addinvoice-ops/watchdog.json (smsTo, emailTo). Posta/SMS ayarları ana uygulamanın System Settings'inden okunur; veritabanı düşerse yerel önbellekten gönderilir.", "Elle deneme: node /var/www/addinvoice-ops/agent/watchdog.mjs --test (bir test e-postası + bir test SMS'i gönderir)."],
    undo: "Salt okunur sayfa. İzleyiciyi kapatmak için /etc/cron.d/addinvoice-ops-watchdog dosyasını sil.",
  },
  // ───────── Yedekler ─────────
  {
    id: "backup-diff", group: "yedek", title: "Fark (diff) yedek al", role: "operator",
    what: "Son TAM yedekten bu yana değişen verinin yedeğini alır. Küçük ve hızlıdır; günlük otomatik yedek de budur.",
    happens: ["Arka planda pgBackRest çalışır, 'İşler' kutusunda ilerlemesi görünür (genelde saniyeler).", "Veritabanı çalışmaya devam eder; kullanıcılar etkilenmez."],
    caution: ["Aynı anda yalnız bir iş çalışır; başka iş sürüyorsa reddedilir.", "Fark yedek tek başına yetmez: geri yüklemede ilgili tam yedek de gerekir (pgBackRest bunu kendisi yönetir)."],
    undo: "Yedek silinmez/geri alınmaz; eski yedekler saklama kuralına göre otomatik temizlenir (2 tam + 7 fark).",
  },
  {
    id: "backup-incr", group: "yedek", title: "Artımlı (incr) yedek al", role: "operator",
    what: "Son yedekten (her türlü) bu yana değişenleri yedekler. Fark yedekten de küçüktür.",
    happens: ["Fark yedekle aynı şekilde arka planda çalışır."],
    caution: ["Zincir uzadıkça geri yükleme biraz daha çok parça okur; bu veri boyutunda fark edilmez."],
    undo: "Yedek zinciri otomatik yönetilir.",
  },
  {
    id: "backup-full", group: "yedek", title: "Tam (full) yedek al", role: "operator",
    what: "Veritabanının tüm yedeğini baştan alır. Her şeyin dayanağıdır; haftalık otomatik alınır.",
    happens: ["Tüm veri dosyaları sıkıştırılıp depoya yazılır (şu an ≈ 70 MB, birkaç on saniye).", "Disk okuma/yazma yükü artar."],
    caution: ["Veri büyüdüğünde (GB'lar) yoğun saatlerde alma — gece otomatik zaten alınıyor.", "Depo şimdilik AYNI diskte; tam yedek diski doldurmasın diye Genel bakış'taki disk yüzdesine bak."],
    undo: "Eski tam yedek 2 adet saklanır; yenisi alınınca en eskisi silinir.",
  },
  {
    id: "restore-point", group: "yedek", title: "İsimli restore noktası", role: "operator",
    what: "Veritabanının log'una 'şu an' diye isimli bir işaret koyar. Riskli işlemden hemen ÖNCE oluşturulursa, gerekirse tam bu ana geri dönebilirsin.",
    happens: ["PostgreSQL'de pg_create_restore_point çalışır ve WAL hemen arşive atılır (pg_switch_wal).", "Veriye dokunmaz, yavaşlatmaz."],
    caution: ["Ad 3-40 karakter: küçük harf, rakam, - ve _. Anlamlı yaz: 'oncesi-buyuk-guncelleme'.", "Noktaya dönmek için komut gerekir — bkz. aşağıdaki 'Üretim geri yükleme' komutları."],
    undo: "Nokta zararsızdır; silinmesi gerekmez.",
  },
  {
    id: "restore-drill", group: "yedek", title: "Geri yükleme provası", role: "operator",
    what: "'Yedeklerim gerçekten geri yüklenebiliyor mu?' sorusunun cevabı. En son yedeği GEÇİCİ bir kopyaya açar, içinde sayım yapar ve kopyayı siler.",
    happens: ["pgBackRest en son yedeği /var/tmp'ye geri yükler, ayrı bir portta (5499) geçici PostgreSQL açar, şirket/kullanıcı/transaction sayısını okur, kapatır ve siler.", "Sonuç 'İşler' kutusunda: ✔ ve kopyadaki sayılar (≈1 dk)."],
    caution: ["Canlı veritabanına KESİNLİKLE dokunmaz (farklı dizin, farklı port, arşivleme kapalı).", "Geçici olarak ~200 MB RAM ve veri boyutu kadar disk kullanır.", "Ayda bir çalıştırmanı öneririm: yedeğin varlığı değil geri yüklenebilirliği önemlidir."],
    undo: "Kendini temizler; geri alınacak bir şey bırakmaz.",
  },
  {
    id: "wal-archive", group: "yedek", title: "WAL arşivleme tablosu", role: "viewer",
    what: "PostgreSQL her değişikliği önce WAL dosyalarına yazar; pgBackRest bunları sürekli arşivler. Bu sayede 'herhangi bir ana' dönülebilir (PITR) ve veri kaybı penceresi ≤ 5 dakikadır.",
    happens: ["Arşivlenen sayısı artıyor, 'Hatalı' 0 kalıyor olmalı.", "'Son arşiv' 5 dakikadan eskiyse veya 'Hatalı' artıyorsa arşivleme takılmıştır."],
    caution: ["Arşivleme uzun süre başarısız olursa PostgreSQL'in pg_wal klasörü şişer ve disk dolabilir — Genel bakış bunu uyarır."],
    undo: "Salt okunur.",
  },
  // ───────── Dış yedekleme (borg) ─────────
  {
    id: "backup-engine", group: "dis-yedek", title: "Yedekleme sayfası nasıl çalışır?", role: "viewer",
    what: "Sunucudaki dosyaları, veritabanını ve sunucu ayarlarını şifreli olarak başka bir yere (linux1, NAS…) yedekleyen görevler. Her görevin kendi takvimi ve hedef(ler)i vardır.",
    happens: ["Sunucuda dakikada bir çalışan zamanlayıcı, zamanı gelen görevi ayrı bir süreç olarak başlatır; ayarlar /etc/addinvoice-backup/config.json dosyasındadır (bu sayfa onu düzenler).", "Veri BU SUNUCUDA şifrelenir (BorgBackup, istemci tarafı); hedef yalnızca şifreli blokları görür. Aynı veri tekrar gönderilmez (tekilleştirme), bu yüzden günde birkaç kez almak ucuzdur.", "Her çalışmanın sonucu (OK/HATA, süre, eklenen boyut) listede ve geçmişte görünür. Bağımsız izleyici hatalı veya zamanında alınmamış yedekte e-posta gönderir."],
    caution: ["Hedefler 'append-only' ise bu sunucu eski arşivleri SİLEMEZ (fidye yazılımı koruması); eski arşivleri temizlemek hedefte yönetici olarak yapılır (budama).", "Şifreleme parolası kaybolursa yedekler AÇILAMAZ: parolayı parola yöneticisinde sakla.", "Yedek ≠ arşiv: yasal saklama (5 yıl) uygulamanın kendi kaydındadır; yedek felaket kurtarma içindir."],
    undo: "Görevi durdurmak/silmek yalnız takvimden çıkarır; hedefteki arşivler korunur. Yapılandırmanın son 30 sürümü sunucuda saklanır.",
  },
  {
    id: "backup-schedule", group: "dis-yedek", title: "Zamanlama nasıl seçilir?", role: "admin",
    what: "Üç yol: 'Her' (her N dakika/saat/gün), 'Cron ifadesi' veya 'Elle seç' (dakika, saat, ayın günü, ay, haftanın günü, yıl).",
    happens: ["Seçtiğin an altında 'Sonraki çalışmalar' önizlemesi çıkar; yanlış bir ifade burada hata verir, kaydedilemez.", "'Ayın son günü' ve 'ayın N. Pazartesi'si' gibi seçimler standart cron'da yoktur; bu sistemde çalışır (zamanlayıcı kendi hesaplar).", "Saatler Danimarka (sunucu) saatidir."],
    caution: ["'Ayın günü' ile 'haftanın günü'nü aynı anda kısıtlayamazsın (iki kısıt birlikte karışır); birini 'Hepsi' bırak.", "Çok sık takvim (her dakika) hedefi ve sunucuyu gereksiz yorar; dosya/DB için saatte bir bile çoğu zaman fazladır.", "Sunucu çalışmıyorken kaçan zamanlar geriye dönük çalıştırılmaz; bağımsız izleyici bunu 'yedek alınmadı' uyarısıyla bildirir."],
    undo: "Takvimi istediğin zaman düzenleyip kaydedebilirsin; eski ayarlara yapılandırma geçmişinden dönülebilir.",
  },
  {
    id: "backup-job-types", group: "dis-yedek", title: "Görev türleri ne yapar?", role: "viewer",
    what: "Bilag dosyaları, site/uygulama dosyaları, tüm veritabanı, önemli tablolar, sunucu ayarları + kurulu programlar, özel yollar, doğrulama.",
    happens: ["Dosya türleri klasörü doğrudan arşivler (node_modules ve derleme çıktıları hariç).", "Veritabanı türleri önce tutarlı bir döküm (pg_dump) üretip okunabilirliğini doğrular, sonra arşivler; döküm bozuksa yedek BAŞARISIZ sayılır ve uyarı gelir.", "Sunucu görevi /etc, cron, sertifikalar, nginx ile birlikte paket listesi, sürümler, pm2, güvenlik duvarı kurallarını kaydeder (programların kendisini değil, yeniden kurmak için listelerini).", "Doğrulama görevi depo bütünlüğünü sınar ve son dökümü açıp okunabildiğini kanıtlar."],
    caution: ["Özel yol yalnız izinli köklerin altından seçilebilir; .env ve gizli anahtarlar için ayrı 'Gizli ayarlar' görevi kullanılır.", "Bu görevler Ops yapılandırmasındaki parolayı/özel anahtarı YEDEKLEMEZ (bilerek): bunlar parola yöneticinde olmalı."],
    undo: "Görev silinse de geçmiş arşivler hedefte kalır.",
  },
  {
    id: "backup-targets", group: "dis-yedek", title: "Yedek hedefleri: Linux sunucu, NAS, bağlı klasör", role: "admin",
    what: "Yedeğin gideceği yer. İki tür vardır: SSH ile erişilen sunucu/NAS (önerilen) ve bu sunucuya bağlı bir klasör (NAS paylaşımı, USB disk).",
    happens: ["Hedefi oluşturunca bu sunucuda anahtar ve şifreleme parolası üretilir; parola YALNIZ bir kez gösterilir.", "Ekranda hedef tarafta yapılacak komutlar çıkar: kullanıcı, borg kurulumu, kısıtlı SSH anahtarı (yalnız borg, yalnız ekleme), parmak izi doğrulama, güvenlik duvarı izni.", "'Bağlantıyı sına' ağ, anahtar, parmak izi ve depo erişimini adım adım kontrol eder. 'Depoyu başlat' şifreli depoyu oluşturur ve hedefi etkinleştirir.", "Bağlantı iki şekilde olur: SSH anahtarı (önerilen; panel üretir, hedefte append-only kurulabilir) veya kullanıcı adı + parola (NAS hesabının parolası bu sunucuda yalnız root okuyabilen dosyada saklanır; ekranda gösterilmez, denetim kaydına yazılmaz; hedef kartından değiştirilebilir).", "NAS (SSH + borg) Linux sunucuyla aynıdır; borg'un NAS'ta kurulabilmesi gerekir (Synology/QNAP'ta paket merkezi, Docker veya Entware). Kurulamıyorsa NAS paylaşımını bu sunucuya bağlayıp 'Bağlı klasör' hedefini kullan."],
    caution: ["Bağlı klasör hedefinde append-only koruma yoktur: fidye yazılımı/yanlış komut yedekleri silebilir. NAS'ta anlık görüntü (snapshot) ve ayrı hesap şart.", "Parola ile bağlanan hedefte append-only koruma yoktur: NAS hesabı yedekleri silebilir. Hesabı yalnız yedek klasörüne kısıtla, NAS'ta anlık görüntü aç. Synology DSM 7'de SSH varsayılan olarak yalnız yönetici grubuna açıktır.", "Bağlama denetimini doldur: NAS bağlı değilse yedek yerel diske yazılmaz, hata verir.", "Parmak izini hedef sunucuda `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` ile karşılaştırmadan devam etme.", "Hedefi silmek uzaktaki yedekleri ve kimlik bilgilerini SİLMEZ."],
    undo: "Hedefi durdurabilir/silebilirsin; uzaktaki depo ve parola dosyası olduğu gibi kalır, sonra yeniden bağlanabilir.",
  },
  // ───────── Veritabanı ─────────
  {
    id: "backup-notify", group: "dis-yedek", title: "Yedek bildirimleri (hata uyarısı, günlük/haftalık özet)", role: "admin",
    what: "Yedeklerin durumunu e-postayla öğrenmek için ayarlar: kime gideceği, hangi tür bildirimlerin açık olacağı, hangi saatte geleceği.",
    happens: ["Hata uyarısı: bir görev bir hedefte art arda seçtiğin sayıda başarısız olunca ya da planlı yedek hiç alınmayınca tek e-posta gelir; aynı turdaki birden çok sorun birleşir. Sorun giderilince (isteğe bağlı) “düzeldi” e-postası gelir. Aynı sorun için tekrar e-posta gelmez.", "Günlük özet: seçtiğin saatte son 24 saatin tablosu (görev × hedef, çalışma sayısı, hata, son arşiv, eklenen veri). Sorun olmayan günlerde de gelmesi önerilir: her sabah geliyorsa sistem ayakta demektir; gelmeyen gün izleyicinin kendisinde sorun olabilir.", "Haftalık özet: son 7 günün hedef başına toplamı.", "İkincil hedef: seçtiğin hedeflerdeki sorunlar “uyarı”, diğerleri “KRİTİK” diye işaretlenir (ör. NAS ek kopyadır).", "Bildirimler bağımsız izleyiciden (15 dakikada bir) gider; haber en geç ~15 dk sonra ulaşır. Yeni eklenen bir hedefte ilk çalışma gelene kadar “planlı yedek alınmadı” uyarısı verilmez."],
    caution: ["Ayar kaydedilmeden önce izleyicinin eski genel uyarısı çalışır (tek sabit adres). Kaydedince yedek uyarıları yalnızca buradan yönetilir; izleyicinin yedek dışı uyarıları (servis, disk, site) eskisi gibi sürer.", "E-posta ayarları (SMTP/Resend) ana uygulamanın Sistem ayarlarındaki ile aynıdır; çalışmıyorsa önce oradan düzelt.", "Deneme düğmeleri kaydedilmiş ayarı kullanır; önce Kaydet."],
    undo: "Bildirimleri kapatmak için üç kutuyu da kaldırıp kaydet. Ayar dosyası: /etc/addinvoice-backup/notify.json.",
  },
  {
    id: "backup-restore", group: "dis-yedek", title: "Geri yükleme sihirbazı (güvenli kopya)", role: "admin",
    what: "Borg arşivlerinden dosya, klasör, tablo veya bir şirketin verisini seçerek GÜVENLİ KOPYAYA geri yükler. Canlı dosyalara ve canlı veritabanına yazmaz.",
    happens: ["Hedef → görev → zaman → seçim sırasıyla ilerlersin. Dosya türünde arşivin içinde klasörlerde gezip dosya/klasör işaretlersin; seçilenler ayrı bir alana açılır ve şifreli bir paket (.tar.enc) olarak indirilir.", "Veritabanı türünde döküm geçici bir veritabanına (restore_xxxx) açılır: tablolar ve satır sayıları listelenir, istediğin tabloyu önizleyebilir, şirkete göre süzebilir, CSV olarak veya şirketin tam paketi olarak indirebilirsin.", "'tables' (postering/kassekladde) arşivleri için şema en yeni TAM dökümden alınır; veriler tablolar arşivinin zamanındadır.", "Her adım denetim kaydına yazılır. Parola yalnız bir kez, işi başlatan yöneticiye gösterilir."],
    caution: ["Veri kişisel bilgi içerir (CVR, banka, maaş…): indirdiğin paketi güvenli sakla, işin bitince sil.", "Geçici veritabanı ve paketler 24 saat sonra otomatik silinir; 'Geçici veritabanını sil' ile hemen de silebilirsin.", "Aynı anda tek geri yükleme/dışa aktarma işi çalışır.", "Canlıya uygulamada iki kip vardır: 'yalnız eksikleri ekle' (mevcut hiçbir veri değişmez, önerilen) ve 'üzerine yaz' (farklı olanlar yedekteki hâline döner; eski hâli geri-al klasörüne alınır). Üst kaydı (ör. bir şirket, hesap) canlıda olmayan satırlar eklenemez: işlem geri alınır, önce üst tabloyu da seç.", "Canlıya uygulama ayrı bir adımdır: önce PLAN (kuru çalıştırma), sonra 'CANLIYA UYGULA' yazarak onay. Kimlik, oturum, denetim izi ve gizli ayar tabloları uygulanamaz; dosyalar yalnız bilag klasörüne yazılır."],
    undo: "Güvenli kopya/indirme canlıya yazmaz: indirilen paketi silmen yeterli. Canlıya uygulamada: dosyalarda üzerine yazılan eski sürümler ve veritabanında değiştirilen eski satırlar 14 gün saklanır (geri-al klasörü), veritabanı işlemi hata olursa tamamen geri alınır ve öncesinde bir restore noktası konur.",
  },
  {
    id: "table-columns", group: "db", title: "Tablolar listesi: sütunlar ne demek?", role: "viewer",
    what: "En büyük 25 tablo ve sağlık göstergeleri.",
    happens: ["Toplam = veri + indeksler. Satır = tahmini canlı satır.", "Ölü % = silinmiş/güncellenmiş ama henüz temizlenmemiş satır oranı. > %5 sarı, > %20 kırmızı.", "Boş alan % = tablo dosyasındaki yeniden kullanılabilir boşluk (şişme/bloat). > %30 sarı.", "Son vacuum = autovacuum'un en son temizlediği zaman."],
    caution: ["Birkaç yüz satırlık küçük tablolarda yüksek yüzde normaldir ve önemsizdir.", "Bölümlenmiş tablolarda (audit_logs) bölümler ayrı gösterilmez; toplam gösterilir."],
    undo: "Salt okunur.",
  },
  {
    id: "analyze", group: "db", title: "ANALYZE", role: "operator",
    what: "Tablonun istatistiklerini yeniler. PostgreSQL sorgu planını bu istatistiklere göre seçer; eskimişse yanlış (yavaş) plan seçebilir.",
    happens: ["Tablonun bir örneğini okuyup istatistikleri günceller.", "Hafiftir, yazmaları ve okumaları ENGELLEMEZ, saniyeler sürer."],
    caution: ["Normalde autovacuum bunu zaten yapar. Büyük toplu veri yüklemesinden/silmesinden hemen sonra veya bir sorgu aniden yavaşladıysa elle çalıştır."],
    undo: "Zararsız; geri alınacak bir şey yok.",
  },
  {
    id: "vacuum", group: "db", title: "VACUUM (ANALYZE)", role: "operator",
    what: "Silinmiş/güncellenmiş satırların bıraktığı ölü alanı temizler ve istatistikleri yeniler. MySQL'deki 'defragmentasyon' derdinin PostgreSQL karşılığı — ama yazmaları durdurmadan çalışır.",
    happens: ["Ölü satırlar yeniden kullanılabilir hale gelir; tablo dosyası genelde KÜÇÜLMEZ (VACUUM FULL değildir), ama şişmesi durur.", "Disk okuma/yazma yükü geçici olarak artar; tablo kilitlenmez."],
    caution: ["Büyük tabloda dakikalar sürebilir; yoğun saatte tek tabloya çalıştır.", "VACUUM FULL (dosyayı yeniden yazan, tabloyu KİLİTLEYEN) bilerek yoktur."],
    undo: "Zararsız; geri alınacak bir şey yok.",
  },
  {
    id: "reindex", group: "db", title: "REINDEX CONCURRENTLY", role: "admin",
    what: "Tablonun indekslerini sıfırdan yeniden kurar. İndeks şiştiğinde (çok güncelleme sonrası) boyutunu ve hızını geri kazandırır.",
    happens: ["Her indeksin yeni bir kopyası yan tarafta kurulur, bitince eskisiyle değiştirilir; yazmalar ve okumalar SÜRER.", "Geçici olarak indeks boyutu kadar ek disk kullanır."],
    caution: ["Yalnız yönetici. Gerçekten gerekmedikçe çalıştırma: PostgreSQL indeksleri çoğunlukla kendini toparlar.", "Başarısız olursa '_ccnew' adlı geçersiz indeks kalabilir; kalırsa Veritabanı sayfasında görünür ve temizlenmelidir (SSH).", "Yoğun yazma sırasında uzun sürebilir."],
    undo: "Eski indeks yeniden kurulumla değişir; geri alınacak bir şey yok. Başarısızlıkta eski indeks çalışmaya devam eder.",
  },
  {
    id: "slow-queries", group: "db", title: "En yavaş sorgular", role: "viewer",
    what: "pg_stat_statements'tan toplam süreye göre en çok zaman harcayan sorgular. Sorgu metninde değerler $1, $2 olarak gizlenir.",
    happens: ["Çağrı sayısı × ortalama süre = toplam yük. Az çağrılıp çok yavaş olan da, çok çağrılıp biraz yavaş olan da buradadır."],
    caution: ["Buradaki bir sorgu 'kötü' demek değildir; önce çağrı sayısına ve ortalamaya bak.", "Düzeltme genelde kod/indeks işidir — bu ekran yalnız teşhis içindir."],
    undo: "Salt okunur.",
  },
  {
    id: "activity-locks", group: "db", title: "Bağlantılar ve kilitler", role: "viewer",
    what: "Şu an çalışan sorgular ve birbirini bekleyenler. 'Engelleyen' sütunu doluysa o sorgu başka bir işlemin kilidini bekliyordur (kırmızı satır).",
    happens: ["Boşta (idle) bağlantılar gizlenir; yalnız çalışan/bekleyen satırlar görünür."],
    caution: ["Kırmızı satır birkaç saniyeden uzun sürüyorsa takılmış bir işlem olabilir. Bu ekran sorgu SONLANDIRMAZ (bilerek)."],
    undo: "Salt okunur.",
  },
  {
    id: "unused-indexes", group: "db", title: "Kullanılmayan indeksler", role: "viewer",
    what: "İstatistiklerin sıfırlanmasından bu yana hiç taranmamış indeksler: gereksiz yer ve yavaşlatan yazma yükü.",
    happens: ["Yalnız listeler; silme yapmaz."],
    caution: ["Yeni eklenmiş veya nadir çalışan (aylık/yıllık rapor) sorguların indeksi de 'kullanılmamış' görünür. Silmeden önce uygulama kodundan kontrol et."],
    undo: "Salt okunur.",
  },
  {
    id: "partitions", group: "db", title: "Bölümleme (partitioning)", role: "viewer",
    what: "Çok büyüyen, ağırlıkla yalnız-ekleme (log gibi) tabloları aylık parçalara böler; eski ay hızlıca arşivlenir/silinir, VACUUM küçük parçalarda çalışır.",
    happens: ["'Aday' etiketi ≈ 5 milyon satırı geçmiş, henüz bölümlenmemiş tabloyu gösterir.", "Şu an yalnız audit_logs bölümlü; transactions bölümlenemez (15 tablo ona yabancı anahtarla bağlı)."],
    caution: ["Bölümleme bir veri taşıma işidir; bu ekran yapmaz. Aday çıkarsa ops/postgres/partition-by-month.sql ve docs/ops-postgres.md §8d izlenir."],
    undo: "Salt okunur.",
  },
  // ───────── Şirketler ─────────
  {
    id: "company-sizes", group: "sirket", title: "Boyut sıralaması", role: "viewer",
    what: "Hangi şirket veritabanında ne kadar yer/satır kaplıyor. Bir şirket diğerlerini yavaşlatıyorsa (veya ayrı veritabanına taşıma zamanı geldiyse) buradan anlaşılır.",
    happens: ["Boyut TAHMİNİDİR: tablo başına ortalama satır boyutu × şirketin satır sayısı.", "'Pay' çubuğu toplam içindeki oranı gösterir."],
    caution: ["Tek bir şirket toplamın %50+'sını tutuyorsa ve toplam GB'larsa, 'ayrı veritabanına taşıma' (dbShard) planını hatırla."],
    undo: "Salt okunur.",
  },
  {
    id: "company-export", group: "sirket", title: "Şifreli dışa aktar", role: "operator",
    what: "TEK bir şirketin bütün verisini (fatura, bilag, posteringer, çalışanlar, ayarlar…) şifreli tek bir dosyaya alır. Kullanım: şirketi taşımak, 'verimi ver' (GDPR) talebi, tek şirketi geri getirmek için yedek.",
    happens: ["Arka planda scripts/company-backup export çalışır (87+18 tablo CSV, manifest ile).", "Çıktı AES-256 + PBKDF2 ile şifrelenip indirilebilir dosya olur; şifresiz kopya hemen silinir.", "İş bitince 'İşler' kutusunda indirme bağlantısı ve BİR KEZ gösterilen parola çıkar.", "Dosya 24 saat sonra otomatik silinir."],
    caution: ["İçinde kişisel veri (CVR, banka, maaş, e-posta) vardır. Parolayı dosyayla AYNI kanaldan gönderme.", "Parola yalnız işi başlatan kişiye ve yalnız bir kez gösterilir; kaybolursa dışa aktarmayı yenile.", "Her dışa aktarma ve indirme denetim kaydına yazılır.", "Yüklenen dosyalar (PDF/fotoğraf) bu arayüzden alınmaz; --with-files için SSH gerekir."],
    undo: "Veriyi değiştirmez. Oluşan dosya 24 saatte silinir.",
  },
  // ───────── Servisler ─────────
  {
    id: "services", group: "servis", title: "Servis durumu tablosu", role: "viewer",
    what: "nginx, PostgreSQL, pgBouncer, uygulama (pm2) ve ops konsolunun çalışıp çalışmadığı.",
    happens: ["'Yeniden başl.' sayısı systemd'nin servisi kaç kez yeniden başlattığıdır — artıyorsa servis çöküyor demektir."],
    caution: [],
    undo: "Salt okunur.",
  },
  {
    id: "service-reload", group: "servis", title: "Reload (yeniden yükle)", role: "operator",
    what: "Servisi KESMEDEN yapılandırmayı yeniden okutur. Ayar değişikliklerinin çoğu reload ile devreye girer.",
    happens: ["nginx: önce 'nginx -t' ile yapılandırma denenir; hatalıysa hiçbir şey yapılmaz. Sonra yeni işçiler başlar, eskiler isteklerini bitirip kapanır — kesinti yok.", "pgBouncer: yapılandırma yeniden okunur; yeni ayarlı bağlantılar açılır (log'da 'database configuration changed' görülür, normaldir).", "PostgreSQL: pg_reload_conf — restart gerektirmeyen ayarlar uygulanır.", "Uygulama (pm2 reload): cluster modunda sırayla yeniden başlatır → kesintisiz. Tek instance modunda kısa kesinti olur."],
    caution: ["Reload sonrası Genel bakış'a bak: servis 'active' kalmalı."],
    undo: "Yapılandırma değiştirdiysen Yapılandırma sayfasından yedeğe dön; reload ile geri yükle.",
  },
  {
    id: "service-restart", group: "servis", title: "Restart (yeniden başlat)", role: "admin",
    what: "Servisi durdurup yeniden başlatır. Yalnız reload'un yetmediği durumlarda (ör. PostgreSQL shared_buffers/max_connections değişikliği, takılmış servis) kullan.",
    happens: ["nginx: tüm bağlantılar kısa süre kesilir (saniyeler).", "pgBouncer: havuzdaki bağlantılar kopar, uygulama otomatik yeniden bağlanır; o sırada birkaç istek hata verebilir.", "PostgreSQL: TÜM veritabanı bağlantıları kopar; 5-30 sn tüm uygulama hata verir. Yazılan veri kaybolmaz (kapanışta güvenli checkpoint).", "Uygulama (pm2 restart): kısa kesinti; cluster'da sırayla değil topluca → 'reload' tercih et."],
    caution: ["PostgreSQL restart'ında servisin adını yazman istenir.", "Yedek veya bakım işi çalışırken ajan reddeder (İşler kutusuna bak).", "Müşterilerin yoğun olduğu saatlerde (hafta içi 08–17) kaçın."],
    undo: "Geri alınmaz ama servis kendiliğinden yeniden açılır. Açılmazsa SSH ile `journalctl -u <servis> -n 50`.",
  },
  {
    id: "logs", group: "servis", title: "Günlükler", role: "operator",
    what: "Uygulama, nginx, PostgreSQL, pgBouncer, pgBackRest ve ops servislerinin son satırları.",
    happens: ["Seçtiğin kaynağın son 100/200/500 satırını okur (salt okunur)."],
    caution: ["Günlükler kişisel veri içerebilir (e-posta, IP, bazen sorgu parametreleri). Her görüntüleme denetim kaydına yazılır.", "Ekran görüntüsü/yapıştırma yaparken müşteri verisini ayıkla."],
    undo: "Salt okunur.",
  },
  // ───────── Config ─────────
  {
    id: "config-edit", group: "config", title: "Yapılandırma düzenleme", role: "admin",
    what: "nginx, pgBouncer ve PostgreSQL ayar dosyalarını güvenli şekilde düzenler: önce yedek alır, doğrular, uygular, sağlık kontrolü yapar, bozulursa OTOMATİK geri alır.",
    happens: ["'Doğrula' dosyayı değiştirmeden dener: nginx → nginx -t; PostgreSQL → ayar sözdizimi ve değer denetimi; pgBouncer → (test modu yok) yalnız uygulamada denenir.", "'Uygula': yedek /var/backups/addinvoice-ops-config altına alınır, dosya yazılır, doğrulanır, servis reload edilir, sağlık kontrolü yapılır (nginx: HTTP+HTTPS isteği; pgBouncer: servis+port; PostgreSQL: sorgu).", "Sağlık kontrolü başarısızsa eski dosya geri yazılır ve servis tekrar reload edilir.", "PostgreSQL için restart gerektiren ayarlar uygulandıktan sonra isim isim listelenir (pending_restart)."],
    caution: ["Mantık hataları (ör. yanlış IP kısıtı) doğrulamayı geçebilir ve seni dışarıda bırakabilir: ops sitesinin nginx dosyasını değiştirirken dikkat; her zaman SSH ile yedekten dönebilirsin.", "Değişiklikten sonra Ayarlar sayfasında etkisini kontrol et.", "Ayarlar bu sayfada yalnız ilgili dosyaya yazılır; parola/anahtar içeren dosyalar (userlist.txt, .env, sertifikalar) bilerek listede YOK."],
    undo: "Her uygulamanın yedeği vardır: listeden yedeği seçip 'Bu yedeğe geri dön'. Son 30 yedek saklanır.",
  },
  // ───────── Kullanıcı ─────────
  {
    id: "roles", group: "kullanici", title: "Roller", role: "admin",
    what: "İzleyici: yalnız okur. Operatör: yedek alır, restore noktası koyar, ANALYZE/VACUUM çalıştırır, şirket dışa aktarır, günlük okur, reload yapar. Yönetici: REINDEX, restart, yapılandırma düzenleme, kullanıcı/denetim.",
    happens: ["Rol değişince kullanıcının tüm oturumları kapanır; tekrar giriş yapar."],
    caution: ["Başkasına en az yetkili rolü ver. Yönetici rolü sunucuyu yeniden başlatabilir ve yapılandırmayı değiştirebilir."],
    undo: "Rol istediğin zaman değiştirilir.",
  },
  {
    id: "invite", group: "kullanici", title: "Davet bağlantısı oluştur", role: "admin",
    what: "Bir kişiye ops konsolu erişimi verir. E-posta gönderilmez: çıkan bağlantıyı kişiye sen iletirsin.",
    happens: ["48 saat geçerli, tek kullanımlık bağlantı üretilir; kişi adını, parolasını belirler ve 2FA'yı (QR) kurar, 8 kurtarma kodu alır."],
    caution: ["Bağlantıyı kimin açtığına bakmaz — kişiye güvenli kanaldan (Signal, yüz yüze) ilet.", "Bağlantı bir daha gösterilmez; kaybolursa yenisini oluştur (eskisi iptal olur)."],
    undo: "'Bekleyen davetler' listesinden iptal edilir.",
  },
  {
    id: "reset-access", group: "kullanici", title: "Erişimi sıfırla", role: "admin",
    what: "Telefonunu/parolasını kaybeden kullanıcı için yeni parola + yeni 2FA kurdurur.",
    happens: ["24 saatlik sıfırlama bağlantısı üretilir; kullanıcının mevcut tüm oturumları kapatılır; bağlantı kullanılana dek eski parola/2FA ÇALIŞMAYA devam eder."],
    caution: ["Kişinin gerçekten o kişi olduğundan emin ol (telefonla doğrula) — bağlantıyı alan hesabı devralır."],
    undo: "Bağlantı kullanılmadan iptal edilebilir (Bekleyen davetler).",
  },
  {
    id: "disable-user", group: "kullanici", title: "Devre dışı bırak", role: "admin",
    what: "Kullanıcının girişini kapatır ve oturumlarını sonlandırır; kayıtları (denetim) silinmez.",
    happens: ["Hemen etkili olur."],
    caution: ["Son yönetici devre dışı bırakılamaz. Kendini devre dışı bırakamazsın."],
    undo: "'Etkinleştir' ile geri açılır.",
  },
  {
    id: "audit", group: "kullanici", title: "Denetim kaydı", role: "admin",
    what: "Kim, ne zaman, hangi IP'den, neyi yaptı. İki ayrı kayıt: web konsolu (hash zincirli) ve root ajanı (root'a ait ayrı dosya).",
    happens: ["Hash zinciri her kaydı öncekine bağlar; biri değiştirilir/silinirse sayfanın başında kırmızı uyarı çıkar."],
    caution: ["Kırmızı uyarı görürsen önce kayıt dosyasını (/var/lib/addinvoice-ops/data/audit.jsonl) yedekle, sonra kimin erişimi olduğunu incele."],
    undo: "Kayıtlar silinemez/değiştirilemez (arayüzden).",
  },
  // ───────── Tuning ─────────
  {
    id: "tuning-page", group: "tuning", title: "Ayarlar (tuning) sayfası", role: "viewer",
    what: "Sunucunun hız/kararlılık ayarlarının CANLI değerleri, her ayarın ne işe yaradığı, hedef değerle karşılaştırması ve değişiklik geçmişi.",
    happens: ["Değerler canlı okunur (PostgreSQL pg_settings, pgBouncer/nginx dosyaları, pm2, çekirdek).", "'Hedef' sütunundaki değerden farklıysa satır sarı olur (bilinçli fark olabilir)."],
    caution: ["Bu sayfa değiştirmez; değiştirmek için Yapılandırma sayfası (yönetici)."],
    undo: "Salt okunur.",
  },
]

export const HELP_BY_ID = Object.fromEntries(HELP.map((h) => [h.id, h]))

export type Cmd = { title: string; where: string; cmd: string; note?: string }
export const COMMANDS: { group: string; items: Cmd[] }[] = [
  {
    group: "Bu konsolun (ops) kendisi",
    items: [
      { title: "Ops sayfalarında değişiklik yaptım — yayına al", where: "herhangi bir klasör (root)", cmd: "/var/www/addinvoice-ops/deploy/redeploy.sh", note: "Derler (`next build`), önbellek bağlantısını yeniden kurar, `addinvoice-ops` servisini yeniden başlatır. Sayfa/eylem/kütüphane kodu değişince GEREKİR." },
      { title: "Ajan kodunu (agent/agent.mjs) değiştirdim", where: "herhangi bir klasör (root)", cmd: "systemctl restart addinvoice-ops-agent", note: "Derleme gerekmez. Çalışan işler (İşler kutusu) sıfırlanır." },
      { title: "SQL fonksiyonlarını (sql/ops-functions.sql) değiştirdim", where: "/var/www/addinvoice-ops", cmd: "sudo -u postgres psql -d addinvoice_db -f sql/ops-functions.sql" },
      { title: "Şirket dışa aktarma betiği (scripts/company-backup.ts) değişti", where: "/var/www/addinvoice-ops", cmd: "agent/build-export.sh && systemctl restart addinvoice-ops-agent", note: "Ajan derlenmiş kopyayı kullanır; script değişince yeniden derlenmeli." },
      { title: "Ops servis durumu / günlüğü", where: "herhangi bir klasör", cmd: "systemctl status addinvoice-ops addinvoice-ops-agent --no-pager\njournalctl -u addinvoice-ops -n 80 --no-pager\njournalctl -u addinvoice-ops-agent -n 80 --no-pager" },
      { title: "Yeni kullanıcı (sıfırdan) için davet bağlantısı", where: "/var/www/addinvoice-ops", cmd: "node scripts/bootstrap-invite.mjs kisi@ornek.dk admin", note: "Web arayüzü açılmıyorsa/erişim kaybolduysa tek çare budur (yalnız root)." },
      { title: "Ana uygulamadaki hesabı ops'a kopyala", where: "/var/www/addinvoice-ops", cmd: "node scripts/seed-user-from-main.mjs nbt@addinvoice.dk admin", note: "Parola özeti kopyalanır (ekrana yazılmaz); 2FA kurulum bağlantısı üretilir." },
    ],
  },
  {
    group: "Ana uygulama (addinvoice.dk) — SENİN çalıştırdığın komutlar",
    items: [
      { title: "Yayına alma (tek instance, şu anki düzen)", where: "/var/www/addinvoice", cmd: "npm run build && pm2 restart addinvoice" },
      { title: "Cluster'a (çok instance) GEÇİŞ — bir kez", where: "/var/www/addinvoice", cmd: "npm run build && npx prisma migrate deploy\npm2 delete addinvoice && pm2 start ecosystem.config.cjs && pm2 save", note: "6 çekirdekten 3'ünü uygulamaya verir; ağır bir istek (AI tarama, PDF) herkesi bloklamaz. Neden güvenli olduğu 'Ayarlar' sayfasında yazılı." },
      { title: "Cluster'da sonraki yayınlar (kesintisiz)", where: "/var/www/addinvoice", cmd: "npm run build && npx prisma migrate deploy && pm2 reload addinvoice" },
      { title: "Uygulama durumu / günlüğü", where: "herhangi bir klasör", cmd: "pm2 list\npm2 logs addinvoice --lines 100 --nostream" },
    ],
  },
  {
    group: "Veritabanı yedek / geri yükleme (SSH, root) — ÜRETİM GERİ YÜKLEME BU ARAYÜZDEN YAPILMAZ",
    items: [
      { title: "Yedek durumu", where: "herhangi bir klasör", cmd: "sudo -u postgres pgbackrest --stanza=addinvoice info\nsudo -u postgres pgbackrest --stanza=addinvoice check" },
      { title: "A) En son duruma geri yükle (tüm WAL oynatılır)", where: "herhangi bir klasör", cmd: "pm2 stop addinvoice\nsystemctl stop postgresql@16-main\nsudo -u postgres pgbackrest --stanza=addinvoice --delta restore\nsystemctl start postgresql@16-main\npm2 start addinvoice\nsudo -u postgres pgbackrest --stanza=addinvoice --type=full backup", note: "Önce uygulamayı durdur ki geri yükleme sırasında yazma olmasın. Yeni zaman çizgisinde İLK İŞ tam yedek." },
      { title: "B) Belirli bir ana geri dön (yanlış silmeden hemen önce)", where: "herhangi bir klasör", cmd: "pm2 stop addinvoice\nsystemctl stop postgresql@16-main\nsudo -u postgres pgbackrest --stanza=addinvoice --delta --type=time --target=\"2026-10-27 14:37:00+01\" --target-action=promote restore\nsystemctl start postgresql@16-main", note: "Hedef zaman seçilen yedeğin bitişinden SONRA olmalı ve o ana kadar WAL'da kayıt bulunmalı; boş zamanda 'recovery ended before configured recovery target' hatası alırsın → isimli nokta kullan." },
      { title: "C) İsimli restore noktasına dön", where: "herhangi bir klasör", cmd: "pm2 stop addinvoice\nsystemctl stop postgresql@16-main\nsudo -u postgres pgbackrest --stanza=addinvoice --delta --type=name --target=oncesi-buyuk-guncelleme --target-action=promote restore\nsystemctl start postgresql@16-main", note: "Ad, 'İsimli restore noktası' ile oluşturduğun addır." },
      { title: "Tek şirketi geri getir (dışa aktarılmış arşivden)", where: "/var/www/addinvoice", cmd: "mkdir -p /var/tmp/sirket && openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in DOSYA.tar.enc | tar -x -C /var/tmp/sirket\nnpx tsx scripts/company-backup.ts import /var/tmp/sirket/<dizin> --target-db GECICI_DB\n# Doğruladıktan sonra canlıya: ... --target-db addinvoice_db --replace-company", note: "ÖNCE boş bir geçici veritabanına aktarıp bak; canlıda --replace-company yalnız o şirketin satırlarını siler/yazar. Canlıda kullanmadan önce o şirketin güncel dışa aktarımını al." },
      { title: "Dışa aktarılan arşivi aç", where: "herhangi bir klasör", cmd: "openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in DOSYA.tar.enc | tar x", note: "Parola, dışa aktarma bittiğinde 'İşler' kutusunda bir kez gösterilen paroladır." },
    ],
  },
  {
    group: "Servisler (SSH, root)",
    items: [
      { title: "nginx yapılandırmasını dene + yeniden yükle", where: "herhangi bir klasör", cmd: "nginx -t && systemctl reload nginx" },
      { title: "PostgreSQL / pgBouncer günlüğü", where: "herhangi bir klasör", cmd: "tail -n 100 /var/log/postgresql/postgresql-16-main.log\ntail -n 100 /var/log/pgbouncer/pgbouncer.log" },
      { title: "Yapılandırma yedeklerine el ile dön", where: "herhangi bir klasör", cmd: "ls /var/backups/addinvoice-ops-config/<anahtar>/\ncp /var/backups/addinvoice-ops-config/pg_tuning/<TARİH> /etc/postgresql/16/main/conf.d/addinvoice-tuning.conf && systemctl reload postgresql@16-main", note: "Anahtarlar: nginx_main, nginx_site, nginx_ops, pgbouncer, pg_tuning. Arayüz erişilemezken kurtarma yolu." },
      { title: "Haftalık veritabanı sağlık raporu", where: "herhangi bir klasör", cmd: "cat /var/log/addinvoice-db-health/$(ls /var/log/addinvoice-db-health | grep txt | tail -1)" },
    ],
  },
]

export const GLOSSARY: { term: string; def: string }[] = [
  { term: "PITR (Point-In-Time Recovery)", def: "Veritabanını, belirli bir güne/saate/isimli noktaya geri döndürebilme. WAL arşivi + tam yedek birlikte sağlar." },
  { term: "WAL (Write-Ahead Log)", def: "PostgreSQL'in her değişikliği diske yazmadan önce kaydettiği günlük. Çökme sonrası kurtarma ve PITR bunun üstüne kuruludur." },
  { term: "Ölü satır (dead tuple)", def: "Silinen veya güncellenen satırın eski sürümü. VACUUM temizleyene kadar yer kaplar; çok birikirse tablo şişer." },
  { term: "Şişme (bloat)", def: "Tablo/indeks dosyasının içinde kullanılmayan boşluk. Disk ve önbellek israfı, yavaşlık." },
  { term: "Autovacuum", def: "PostgreSQL'in kendi kendine çalışan temizlik işçisi. Burada 30 sn'de bir bakar ve agresif çalışacak şekilde ayarlıdır (MySQL'deki defrag derdinin karşılığı)." },
  { term: "pgBouncer (transaction modu)", def: "Uygulamanın yüzlerce bağlantısını 20 gerçek PostgreSQL bağlantısına indirger. Her işlem (transaction) için bağlantı ödünç alınır." },
  { term: "Cluster modu (pm2)", def: "Aynı uygulamanın birkaç kopyası aynı portu paylaşır; gelen istekler aralarında dağıtılır. Tek kopya tek çekirdeği kullanır." },
  { term: "Reload / Restart", def: "Reload: servisi kesmeden yapılandırmayı yeniden okutur. Restart: durdurup baştan başlatır (kısa kesinti)." },
  { term: "Hash zinciri", def: "Her denetim kaydı bir öncekinin özetini içerir; araya kayıt sokulması/silinmesi zinciri bozar ve fark edilir." },
]
