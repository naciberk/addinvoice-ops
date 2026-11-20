"use client"

import { RunButton } from "./run-button"
import { exportCompany } from "@/app/(panel)/actions"

export function ExportButton({ id, name }: { id: string; name: string }) {
  return (
    <RunButton
      label="Şifreli dışa aktar"
      action={() => exportCompany(id, name)}
      confirm={`"${name}" şirketinin TÜM verisi (kişisel veri içerir) şifreli bir arşive aktarılsın mı? İşlem kayda alınır.`}
    />
  )
}
