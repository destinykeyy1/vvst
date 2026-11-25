import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, PageHeader, Panel, StatCard } from "@/components/ui-kit";
import { PasswordGate } from "@/components/PasswordGate";
import { computeStats, formatNumber } from "@/lib/logic";
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

function timeNow() {
  return new Date().toLocaleTimeString("ru-RU");
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
  const [updated, setUpdated] = useState("");
  const [now, setNow] = useState(() => new Date());
  useEffect(() => setUpdated(timeNow()), []);
  const stats = computeStats(state, now);
  const attention = stats.needsAttention.length;

  return (
    <div>
      <PageHeader
        title="Статистика"
        subtitle={`Обновлено: ${updated}`}
        actions={
          <Button
            variant="outline"
            onClick={() => {
              setNow(new Date());
              setUpdated(timeNow());
            }}
          >
            Обновить
          </Button>
        }
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard label="Всего машин" value={stats.total} />
        <StatCard label="Готово к выезду" value={stats.ready} />
        <StatCard label="В ремонте" value={stats.repair} />
        <StatCard label="Всего нарядов" value={stats.orders} />
        <StatCard label="За этот месяц" value={stats.ordersThisMonth} />
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
