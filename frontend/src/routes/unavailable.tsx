import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Button, Input, PageHeader, Panel, StatCard } from "@/components/ui-kit";
import { PasswordGate } from "@/components/PasswordGate";
import { useState } from "react";

export const Route = createFileRoute("/unavailable")({
  component: () => (
    <PasswordGate section="unavailable" title="Недоступные">
      <UnavailablePage />
    </PasswordGate>
  ),
});

function UnavailablePage() {
  const [query, setQuery] = useState("");
  const [filter1, setFilter1] = useState<"all" | "active" | "upcoming" | "past">("all");
  const [filter2, setFilter2] = useState<"all" | "manual" | "orders">("all");

  return (
    <div>
      <PageHeader
        title="НЕДОСТУПНЫЕ"
        subtitle="Машины, временно недоступные к выводу"
        actions={
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Добавить запись
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="ВСЕГО ЗАПИСЕЙ" value={0} />
        <StatCard label="АКТИВНЫ СЕГОДНЯ" value={0} />
        <StatCard label="В РЕМОНТЕ" value={<span className="text-destructive">0</span>} />
        <StatCard label="В НАРЯДАХ" value={0} />
      </div>

      <Panel className="mb-4 flex flex-wrap gap-2 p-3">
        <Input className="w-80" placeholder="Поиск по марке или гос. номеру..." value={query} onChange={(e) => setQuery(e.target.value)} />
      </Panel>

      <Panel className="mb-4 flex flex-wrap gap-2 p-3">
        <div className="flex gap-1">
          <Button variant={filter1 === "all" ? "default" : "outline"} size="sm" onClick={() => setFilter1("all")}>
            Все
          </Button>
          <Button variant={filter1 === "active" ? "default" : "outline"} size="sm" onClick={() => setFilter1("active")}>
            Активные
          </Button>
          <Button variant={filter1 === "upcoming" ? "default" : "outline"} size="sm" onClick={() => setFilter1("upcoming")}>
            Предстоящие
          </Button>
          <Button variant={filter1 === "past" ? "default" : "outline"} size="sm" onClick={() => setFilter1("past")}>
            Прошедшие
          </Button>
        </div>
        <div className="ml-4 flex gap-1">
          <Button variant={filter2 === "all" ? "default" : "outline"} size="sm" onClick={() => setFilter2("all")}>
            Все
          </Button>
          <Button variant={filter2 === "manual" ? "default" : "outline"} size="sm" onClick={() => setFilter2("manual")}>
            Вручную
          </Button>
          <Button variant={filter2 === "orders" ? "default" : "outline"} size="sm" onClick={() => setFilter2("orders")}>
            Из нарядов
          </Button>
        </div>
      </Panel>

      <Panel className="py-20 text-center">
        <p className="text-muted-foreground">Записей о недоступности нет</p>
      </Panel>
    </div>
  );
}