import { useState } from "react";
import { orderTabs } from "@/lib/orderTabs";
import { Link, useLocation } from "@tanstack/react-router";
import { ChevronDown, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

export const NAV = [
  { to: "/", label: "Статистика", locked: true },
  { to: "/vvst", label: "Перечень ВВСТ", locked: true },
  { to: "/registry-changes", label: "История изменений ВВСТ", locked: true },
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
  const location = useLocation();
  const [expanded, setExpanded] = useState(location.pathname === "/order");
  return (
    <aside className="no-print sticky top-0 flex h-screen w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="border-b border-sidebar-border px-6 py-6">
        <div className="text-sm font-semibold tracking-wide text-sidebar-active-foreground">ПЛАНИРОВАНИЕ ВВСТ</div>
        <div className="mt-1 text-xs">Филиал ВА МТО, г. Омск</div>
      </div>
      <nav className="thin-scroll flex-1 overflow-y-auto py-3">
        {NAV.map((item) => (
          <div key={item.to} onMouseEnter={() => { if (item.to === "/order") setExpanded(true); }} onMouseLeave={() => { if (item.to === "/order") setExpanded(false); }}>
          <div className="flex">
          <Link
            to={item.to}
            onClick={() => { if (item.to === "/order") setExpanded(true); }}
            activeOptions={{ exact: item.to === "/" }}
            className={cn(
              "flex flex-1 items-center justify-between gap-2 border-l-2 border-transparent px-6 py-3 text-sm leading-5 transition-colors hover:bg-sidebar-active/60 hover:text-sidebar-active-foreground",
            )}
            activeProps={{ className: "!border-sidebar-active-foreground bg-sidebar-active text-sidebar-active-foreground" }}
          >
            <span>{item.label}</span>
            {item.to !== "/journal" && item.to !== "/duty" && <Lock className="h-3.5 w-3.5 shrink-0 text-sidebar-muted" />}
          </Link>
          {item.to === "/order" && <button type="button" aria-label="Разделы наряда" aria-expanded={expanded} className="px-3 hover:bg-sidebar-active" onClick={() => setExpanded(!expanded)}><ChevronDown size={16} className={expanded ? "" : "-rotate-90"} /></button>}
          </div>
          {item.to === "/order" && expanded && (
            <div className="pb-2">
              {orderTabs.map((tab) => (
                <Link key={tab.key} to="/order" search={{ tab: tab.key }}
                  className={cn("block border-l-2 border-transparent pl-10 pr-2 py-2 text-xs hover:bg-sidebar-active",
                    location.pathname === "/order" && (location.search as { tab?: string }).tab === tab.key && "border-white bg-neutral-800 text-white")}>
                  {tab.label}
                </Link>
              ))}
            </div>
          )}
          </div>
        ))}
      </nav>
      <div className="border-t border-sidebar-border px-6 py-4 text-xs text-sidebar-muted">Версия 1.3.2</div>
    </aside>
  );
}
