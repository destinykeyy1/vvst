import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Check } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, PageHeader, Panel, StatCard } from "@/components/ui-kit";
import { PasswordGate } from "@/components/PasswordGate";
import { apiGetCollection } from "@/lib/api";
import { computeStats, formatNumber, isoDate } from "@/lib/logic";
import { useAppState } from "@/lib/store";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Статистика — Планирование ВВСТ" },
      { name: "description", content: "Сводная статистика по машинам, нарядам и пробегу ВВСТ." },
      { property: "og:title", content: "Статистика — Планирование ВВСТ" },
      { property: "og:description", content: "Сводная статистика по машинам, нарядам и пробегу ВВСТ." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: StatisticsPage,
});

type UnavailableRecord = {
  vehicleId: number;
  startDate: string;
  endDate: string;
  reason: string;
};

async function loadTotals(signal: AbortSignal): Promise<{ orders: number; departures: number }> {
  const response = await fetch("/api/statistics/totals", { signal, cache: "no-store" });
  if (!response.ok) throw new Error("Не удалось загрузить число нарядов и выездов.");
  return response.json();
}

function StatisticsPage() {
  return (
    <PasswordGate section="statistics" title="Статистика">
      <StatisticsContent />
    </PasswordGate>
  );
}

function StatisticsContent() {
  const state = useAppState((s) => s);
  const [now, setNow] = useState(() => new Date());
  const repairs = useQuery({
    queryKey: ["unavailable"],
    queryFn: () => apiGetCollection<UnavailableRecord>("unavailable"),
  });
  const totals = useQuery({
    queryKey: ["statistics", "totals"],
    queryFn: ({ signal }) => loadTotals(signal),
    refetchOnMount: "always",
  });
  const current = repairs.dataUpdatedAt > now.getTime() ? new Date(repairs.dataUpdatedAt) : now;
  const today = isoDate(current.getFullYear(), current.getMonth(), current.getDate());
  const stats = useMemo(() => {
    const activeRepairs = new Set(
      (repairs.data ?? []).filter(entry =>
        entry.reason === "Ремонт" && entry.startDate <= today && today <= entry.endDate,
      ).map(entry => entry.vehicleId),
    );
    const vehicles = state.vehicles.map(vehicle =>
      activeRepairs.has(vehicle.id) ? { ...vehicle, status: "repair" as const } : vehicle,
    );
    return computeStats({ ...state, vehicles }, now);
  }, [state, repairs.data, today, now]);
  const attention = stats.needsAttention.length;

  return (
    <div>
      <PageHeader
        title="Статистика"
        subtitle={`Обновлено: ${current.toLocaleTimeString("ru-RU")}`}
        actions={
          <Button
            variant="outline"
            disabled={repairs.isFetching || totals.isFetching}
            onClick={() => {
              setNow(new Date());
              void repairs.refetch();
              void totals.refetch();
            }}
          >
            Обновить
          </Button>
        }
      />
      {totals.isError && (
        <p role="alert" className="mb-4 text-sm text-destructive">Не удалось обновить число нарядов и выездов.</p>
      )}
      {repairs.isError && (
        <p role="alert" className="mb-4 text-sm text-destructive">Не удалось обновить данные о ремонте.</p>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard label="Всего машин" value={stats.total} />
        <StatCard label="Готово к выезду" value={stats.ready} />
        <StatCard label="В ремонте" value={stats.repair} />
        <StatCard label="Всего нарядов" value={totals.data?.orders ?? "—"} />
        <StatCard label="Всего выездов" value={totals.data?.departures ?? "—"} />
        <StatCard label="Средний пробег" value={`${formatNumber(stats.avgMileage)} км`} />
      </div>

      <Panel className="mt-6 bg-muted">
        <div className="flex items-center justify-between px-6 py-4 text-sm">
          <div className="flex items-center gap-4">
            {attention === 0 ? (
              <Check className="h-4 w-4" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-warning" />
            )}
            <span>{attention === 0 ? "Все машины в норме" : "Требуют внимания (ремонт, недоступны или превышен ТО)"}</span>
          </div>
          <span className="font-semibold">{attention} машин</span>
        </div>
        {attention > 0 && (
          <ul className="border-t border-border">
            {stats.needsAttention.map((v) => (
              <li key={v.id} className="flex justify-between border-b border-border px-6 py-2.5 text-sm last:border-0">
                <span>
                  {v.brand} <span className="text-muted-foreground">· {v.plate}</span>
                </span>
                <span className="text-muted-foreground">
                  {v.status === "repair"
                    ? "В ремонте"
                    : v.status === "unavailable"
                      ? "Недоступна"
                      : `Пробег ${formatNumber(v.mileage)} км — требуется ТО`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
