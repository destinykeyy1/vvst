import { Link } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";

export const NAV = [
  { to: "/", label: "Статистика", locked: true },
  { to: "/vvst", label: "Перечень ВВСТ", locked: true },
  { to: "/card", label: "Индивидуальная карточка ВВСТ", locked: true },
  { to: "/oup", label: "Расписание ОУП", locked: true },
  { to: "/household", label: "Хозяйственная деятельность", locked: true },
  { to: "/events", label: "Расписание иных мероприятий", locked: true },
  { to: "/history", label: "История эксплуатации" },
  { to: "/journal", label: "Журнал" },
  { to: "/duty", label: "Дежурный по парку" },
  { to: "/order", label: "Наряд", locked: true },
  { to: "/unavailable", label: "Недоступные", locked: true },
  { to: "/writeoff/akb", label: "Списание АКБ", locked: true },
  { to: "/writeoff/tires", label: "Списание шин", locked: true },
  { to: "/writeoff/headsets", label: "Списание шлемофонов", locked: true },
  { to: "/writeoff/tarps", label: "Списание брезентов", locked: true },
] as const;

export function AppSidebar() {
  return (
    <aside className="no-print sticky top-0 flex h-screen w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="border-b border-sidebar-border px-6 py-6">
        <div className="text-sm font-semibold tracking-wide text-sidebar-active-foreground">ПЛАНИРОВАНИЕ ВВСТ</div>
        <div className="mt-1 text-xs">Филиал ВА МТО, г. Омск</div>
      </div>
      <nav className="thin-scroll flex-1 overflow-y-auto py-3">
        {NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            activeOptions={{ exact: item.to === "/" }}
            className={cn(
              "flex items-center justify-between gap-2 border-l-2 border-transparent px-6 py-3 text-sm leading-5 transition-colors hover:bg-sidebar-active/60 hover:text-sidebar-active-foreground",
            )}
            activeProps={{ className: "!border-sidebar-active-foreground bg-sidebar-active text-sidebar-active-foreground" }}
          >
            <span>{item.label}</span>
            {"locked" in item && item.locked && <Lock className="h-3.5 w-3.5 shrink-0 text-sidebar-muted" />}
          </Link>
        ))}
      </nav>
      <div className="border-t border-sidebar-border px-6 py-4 text-xs text-sidebar-muted">Версия 1.3.2</div>
    </aside>
  );
}
