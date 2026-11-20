import type { Role } from "./store"

export const ROLE_RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 }
export const ROLE_LABEL: Record<Role, string> = { viewer: "İzleyici", operator: "Operatör", admin: "Yönetici" }
export const ROLE_HELP: Record<Role, string> = {
  viewer: "Yalnız okur: sağlık, yedek durumu, veritabanı raporları, şirket boyutları.",
  operator: "İzleyici + yedek alma, restore noktası, ANALYZE/VACUUM, şirket dışa aktarma, servis günlükleri.",
  admin: "Operatör + REINDEX, kullanıcı/davet yönetimi, denetim kaydının tamamı.",
}
export const can = (role: Role, min: Role) => ROLE_RANK[role] >= ROLE_RANK[min]
