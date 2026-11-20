"use client"

import { RunButton } from "./run-button"
import { restoreDrill } from "@/app/(panel)/actions"

export function DrillButton() {
  return <RunButton label="Geri yükleme provası çalıştır" confirm="Son yedek geçici bir kopyaya geri yüklenip sayılacak ve silinecek. Canlı veritabanına dokunulmaz. Başlatılsın mı?" action={() => restoreDrill()} />
}
