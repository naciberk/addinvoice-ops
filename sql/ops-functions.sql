-- Ops-konsol: salt-okunur izleme fonksiyonları (26 Ekim 2026).
-- postgres olarak uygulanır; SECURITY DEFINER → ops_monitor kullanıcısı iş tablolarına
-- doğrudan SELECT hakkı olmadan yalnız bu özetleri görebilir. Satır içeriği ASLA dönmez.
CREATE SCHEMA IF NOT EXISTS ops;

-- Şirket başına satır sayısı + tahmini boyut (company_id kolonu olan tüm tablolar).
CREATE OR REPLACE FUNCTION ops.company_sizes()
RETURNS TABLE(company_id text, company_name text, slug text, total_rows bigint, est_bytes bigint, top_table text, top_rows bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r record;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _ops_cs(cid text, tbl text, n bigint, bytes bigint) ON COMMIT DROP;
  TRUNCATE _ops_cs;
  FOR r IN
    SELECT c.relname AS tbl,
           GREATEST(c.reltuples, 1)::float8 AS reltuples,
           pg_total_relation_size(c.oid)::float8 AS total_bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
    WHERE c.relkind IN ('r','p') AND NOT c.relispartition
  LOOP
    EXECUTE format(
      'INSERT INTO _ops_cs SELECT company_id::text, %L, count(*), (count(*) * %L::float8)::bigint FROM public.%I WHERE company_id IS NOT NULL GROUP BY company_id',
      r.tbl, (r.total_bytes / r.reltuples), r.tbl);
  END LOOP;
  RETURN QUERY
  SELECT co.id::text, co.name::text, co.slug::text,
         COALESCE(sum(x.n), 0)::bigint,
         COALESCE(sum(x.bytes), 0)::bigint,
         (SELECT x2.tbl FROM _ops_cs x2 WHERE x2.cid = co.id ORDER BY x2.n DESC LIMIT 1),
         (SELECT x2.n FROM _ops_cs x2 WHERE x2.cid = co.id ORDER BY x2.n DESC LIMIT 1)
  FROM public.companies co
  LEFT JOIN _ops_cs x ON x.cid = co.id
  GROUP BY co.id, co.name, co.slug
  ORDER BY 5 DESC;
END $$;

-- Şişme (bloat) tahmini: pgstattuple_approximate ile ilk N büyük tablo.
CREATE OR REPLACE FUNCTION ops.bloat(lim int DEFAULT 25)
RETURNS TABLE(table_name text, total_bytes bigint, dead_tuple_pct numeric, free_pct numeric, approx_scanned_pct numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r record; s record;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname, pg_total_relation_size(c.oid) AS tb
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE c.relkind = 'r' AND NOT c.relispartition
    ORDER BY pg_total_relation_size(c.oid) DESC LIMIT lim
  LOOP
    BEGIN
      SELECT * INTO s FROM public.pgstattuple_approx(r.oid);
      table_name := r.relname; total_bytes := r.tb;
      dead_tuple_pct := round(s.dead_tuple_percent::numeric, 2);
      free_pct := round(s.approx_free_percent::numeric, 2);
      approx_scanned_pct := round(s.scanned_percent::numeric, 1);
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;
  END LOOP;
END $$;

-- Bölümleme adayları: büyük, yalnız-ekleme (insert ağırlıklı) ve henüz bölümlenmemiş tablolar.
CREATE OR REPLACE FUNCTION ops.partition_candidates()
RETURNS TABLE(table_name text, total_bytes bigint, est_rows bigint, n_tup_ins bigint, n_tup_upd bigint, n_tup_del bigint, partitioned boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.relname::text, pg_total_relation_size(c.oid), GREATEST(c.reltuples,0)::bigint,
         COALESCE(s.n_tup_ins,0), COALESCE(s.n_tup_upd,0), COALESCE(s.n_tup_del,0),
         c.relkind = 'p'
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
  WHERE c.relkind IN ('r','p') AND NOT c.relispartition
  ORDER BY pg_total_relation_size(c.oid) DESC
  LIMIT 30
$$;

-- Bölümlerin listesi (bölümlenmiş tablolar için).
CREATE OR REPLACE FUNCTION ops.partitions()
RETURNS TABLE(parent text, partition text, bound text, total_bytes bigint, est_rows bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.relname::text, c.relname::text, pg_get_expr(c.relpartbound, c.oid),
         pg_total_relation_size(c.oid), GREATEST(c.reltuples,0)::bigint
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent AND p.relkind = 'p'
  JOIN pg_namespace n ON n.oid = p.relnamespace AND n.nspname = 'public'
  ORDER BY p.relname, c.relname
$$;

-- Kullanılmayan (hiç taranmamış) indeksler.
CREATE OR REPLACE FUNCTION ops.unused_indexes()
RETURNS TABLE(table_name text, index_name text, index_bytes bigint, idx_scan bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.relname::text, s.indexrelname::text, pg_relation_size(s.indexrelid), s.idx_scan
  FROM pg_stat_user_indexes s
  JOIN pg_index i ON i.indexrelid = s.indexrelid
  WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
  ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT 30
$$;

-- En yavaş sorgular (parametreli metin; veri değerleri pg_stat_statements'ta zaten normalize).
CREATE OR REPLACE FUNCTION ops.slow_queries(lim int DEFAULT 15)
RETURNS TABLE(query text, calls bigint, total_ms numeric, mean_ms numeric, max_ms numeric, rows bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT left(regexp_replace(q.query, '\s+', ' ', 'g'), 300), q.calls,
         round(q.total_exec_time::numeric, 1), round(q.mean_exec_time::numeric, 2),
         round(q.max_exec_time::numeric, 1), q.rows
  FROM public.pg_stat_statements q
  JOIN pg_database d ON d.oid = q.dbid AND d.datname = current_database()
  ORDER BY q.total_exec_time DESC LIMIT lim
$$;

-- Aktif bağlantılar + kilit bekleyenler (sorgu metni kısaltılmış).
CREATE OR REPLACE FUNCTION ops.activity()
RETURNS TABLE(pid int, usename text, application_name text, state text, wait_event_type text, wait_event text,
              running_secs numeric, blocked_by int[], query text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.pid, a.usename::text, a.application_name::text, a.state, a.wait_event_type, a.wait_event,
         round(extract(epoch FROM now() - a.query_start)::numeric, 1),
         pg_blocking_pids(a.pid),
         left(regexp_replace(a.query, '\s+', ' ', 'g'), 200)
  FROM pg_stat_activity a
  WHERE a.datname = current_database() AND a.pid <> pg_backend_pid() AND a.backend_type = 'client backend'
  ORDER BY a.query_start NULLS LAST LIMIT 60
$$;

REVOKE ALL ON FUNCTION ops.company_sizes(), ops.bloat(int), ops.partition_candidates(), ops.partitions(),
  ops.unused_indexes(), ops.slow_queries(int), ops.activity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.company_sizes(), ops.bloat(int), ops.partition_candidates(), ops.partitions(),
  ops.unused_indexes(), ops.slow_queries(int), ops.activity() TO ops_monitor;
GRANT USAGE ON SCHEMA ops TO ops_monitor;

-- Şirket arama (CVR / GLN(EAN) / ad / slug / id) — Erhvervsstyrelsen: makam talebinde doğru müşteriyi hızla bulmak (17 Kas 2026).
-- Yalnız tanımlayıcı alanlar döner (kamu sicili verisi); en fazla 25 satır; en az 3 karakter. CVR, GLN/EAN, P-nr. ve SE-nr. ile aranır (17 Kas 2026: P/SE alanları eklendi).
CREATE OR REPLACE FUNCTION ops.company_lookup(q text)
RETURNS TABLE(company_id text, company_name text, slug text, cvr text, gln text, company_type text, is_test boolean, created_at timestamp)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH p AS (SELECT btrim(q) AS s, regexp_replace(q, '\D', '', 'g') AS d)
  SELECT co.id::text, co.name::text, co.slug::text, co.business_vat_number::text, co.ean_number::text, co.type::text, co.is_test_company, co.created_at::timestamp
  FROM public.companies co, p
  WHERE length(p.s) >= 3 AND (
        co.name ILIKE '%' || replace(replace(replace(p.s, '\', '\\'), '%', '\%'), '_', '\_') || '%'
     OR co.slug ILIKE '%' || replace(replace(replace(p.s, '\', '\\'), '%', '\%'), '_', '\_') || '%'
     OR co.id = p.s
     OR (length(p.d) >= 4 AND (regexp_replace(coalesce(co.business_vat_number, ''), '\D', '', 'g') = p.d
                            OR regexp_replace(coalesce(co.ean_number, ''), '\D', '', 'g') = p.d
                            OR p.d = ANY(co.business_p_numbers)
                            OR p.d = ANY(co.business_se_numbers))))
  ORDER BY co.name
  LIMIT 25
$$;
REVOKE ALL ON FUNCTION ops.company_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.company_lookup(text) TO ops_monitor;

