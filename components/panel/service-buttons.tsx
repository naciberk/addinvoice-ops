"use client"

import { RunButton } from "./run-button"
import { serviceAction } from "@/app/(panel)/actions"

const NAMES: Record<string, string> = { nginx: "nginx", pgbouncer: "pgBouncer", postgresql: "PostgreSQL", app: "Uygulama (pm2)" }

export function ServiceButtons({ canRestart }: { canRestart: boolean }) {
  return (
    <table className="w-full">
      <tbody>
        {Object.keys(NAMES).map((s) => (
          <tr key={s} className="border-t">
            <td className="px-2 py-2 text-sm font-medium w-40">{NAMES[s]}</td>
            <td className="px-2 py-2 flex flex-wrap gap-2 items-center">
              <RunButton label="Reload" confirm={`${NAMES[s]} yeniden yüklensin mi? (kesintisiz; yapılandırmayı yeniden okur)`} action={() => serviceAction(s, "reload")} />
              {canRestart && (
                <RunButton
                  label="Restart"
                  variant="destructive"
                  typed={s === "postgresql" ? "postgresql" : undefined}
                  confirm={s === "postgresql" ? "PostgreSQL yeniden başlatılacak: tüm uygulama 5-30 sn hata verir." : `${NAMES[s]} yeniden başlatılsın mı? (kısa kesinti)`}
                  action={() => serviceAction(s, "restart")}
                />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
