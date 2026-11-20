"use client"

import { RunButton } from "./run-button"
import { runMaintenance } from "@/app/(panel)/actions"

export function TableActions({ table, canReindex }: { table: string; canReindex: boolean }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      <RunButton label="ANALYZE" action={() => runMaintenance("analyze", table)} confirm={`${table}: ANALYZE çalıştırılsın mı? (hafif, kilitlemez)`} />
      <RunButton label="VACUUM" action={() => runMaintenance("vacuum", table)} confirm={`${table}: VACUUM (ANALYZE) çalıştırılsın mı? (yazmaları engellemez; G/Ç yükü oluşturur)`} />
      {canReindex && <RunButton label="REINDEX" action={() => runMaintenance("reindex", table)} confirm={`${table}: REINDEX CONCURRENTLY çalıştırılsın mı? (yazmaları engellemez ama uzun sürebilir ve geçici disk kullanır)`} />}
    </span>
  )
}
