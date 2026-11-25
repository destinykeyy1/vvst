import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { CheckCircle2, Circle } from "lucide-react";
import { Button, Input, PageHeader, Panel } from "@/components/ui-kit";
import { PasswordGate } from "@/components/PasswordGate";
import { useAppState } from "@/lib/store";
import { CARD_FIELDS, ABSENT } from "@/lib/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/card")({
  component: () => (
    <PasswordGate section="card" title="Индивидуальная карточка ВВСТ">
      <CardListPage />
    </PasswordGate>
  ),
});

function CardListPage() {
  const vehicles = useAppState((s) => s.vehicles);
  const [query, setQuery] = useState("");

  const filteredVehicles = useMemo(() => {
    const q = query.trim().toLowerCase();
    return vehicles.filter(
      (v) => !q || v.brand.toLowerCase().includes(q) || v.plate.toLowerCase().includes(q),
    );
  }, [vehicles, query]);

  return (
    <div>
      <PageHeader
        title="ИНДИВИДУАЛЬНАЯ КАРТОЧКА ВВСТ"
        subtitle="Выберите машину, чтобы просмотреть или изменить данные её карточки"
      />

      <Panel className="mb-4 p-3">
        <Input
          className="w-80"
          placeholder="Поиск по марке или государственному номеру..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </Panel>

      <Panel className="thin-scroll max-h-[calc(100vh-20rem)] overflow-auto">
        {filteredVehicles.length === 0 ? (
          <div className="py-20 text-center text-muted-foreground">
            {query ? "Машины не найдены" : "Список машин пуст"}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filteredVehicles.map((vehicle) => (
              <Link
                key={vehicle.id}
                to="/card/$vehicleId"
                params={{ vehicleId: String(vehicle.id) }}
                className="block px-6 py-4 hover:bg-accent transition-colors"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1">
                    <div className="font-medium">{vehicle.brand}</div>
                    <div className="text-sm text-muted-foreground">{vehicle.plate}</div>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-success" />
                    Карточка заполнена
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}