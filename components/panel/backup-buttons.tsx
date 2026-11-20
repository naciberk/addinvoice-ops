"use client"

import { RunButton } from "./run-button"
import { runBackup } from "@/app/(panel)/actions"

export function BackupButtons() {
  return (
    <div className="flex flex-wrap gap-2">
      <RunButton label="Fark (diff) yedek al" action={() => runBackup("diff")} confirm="Fark yedek başlatılsın mı?" />
      <RunButton label="Artımlı (incr) yedek al" action={() => runBackup("incr")} confirm="Artımlı yedek başlatılsın mı?" />
      <RunButton label="Tam (full) yedek al" action={() => runBackup("full")} confirm="Tam yedek başlatılsın mı? (Disk G/Ç yükü oluşturur; yoğun saatlerde önerilmez.)" />
    </div>
  )
}
