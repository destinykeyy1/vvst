import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Panel } from "@/components/ui-kit";
import { apiGetCollection } from "@/lib/api";
import { setState } from "@/lib/store";
import { vehicleFromDto } from "@/lib/backendMap";
import type { VehicleDto } from "@/lib/types";
import { toast } from "sonner";

export const Route = createFileRoute("/duty")({ component: DutyPage });
const hourField = "Текущие показания МОТОЧАСОВ";
function hoursOf(vehicle?: VehicleDto) {
  const value = vehicle?.passportData?.find(p => p.header.trim().replace(/\s+/g, " ").toLowerCase() === hourField.toLowerCase())?.value;
  if (value == null || String(value).trim() === "") return null;
  const hours = Number(String(value).replace(/\s+/g, "").replace(",", "."));
  return Number.isFinite(hours) && hours >= 0 ? hours : null;
}

const label = "block text-xs uppercase leading-4 text-[#737373]";
const hint = "text-xs leading-4 text-[#737373]";
const readingBox = "rounded-md border border-[#e2e2e2] px-3 py-3 text-sm";

function format(value: number | null, unit: string) {
  return value === null ? "—" : `${value.toLocaleString("ru-RU")} ${unit}`;
}

function DutyPage() {
  const client = useQueryClient();
  const fleet = useQuery({
    queryKey: ["vehicles"],
    queryFn: () => apiGetCollection<VehicleDto>("vehicles"),
    refetchOnMount: "always",
  });
  const vehicles = fleet.data ?? [];
  const [query, setQuery] = useState("");
  const [selected, select] = useState<number>();
  const [km, setKm] = useState("");
  const [hours, setHours] = useState("");
  const [date, setDate] = useState(() => new Date().toLocaleDateString("sv-SE"));
  const [saved, setSaved] = useState(false);
  const shown = vehicles.filter(v => `${v.brand} ${v.regNumber}`.toLowerCase().includes(query.trim().toLowerCase()));
  const vehicle = vehicles.find(v => v.id === selected);
  const startHours = hoursOf(vehicle);
  const endKm = km === "" ? null : Number(km);
  const endHours = hours === "" ? null : Number(hours);
  const kmDiff = vehicle && endKm !== null ? endKm - vehicle.currentMileage : null;
  const hoursDiff = startHours !== null && endHours !== null ? endHours - startHours : null;
  const invalid = (endKm !== null && (!Number.isSafeInteger(endKm) || (kmDiff ?? 0) < 0)) ||
    (endHours !== null && (!Number.isFinite(endHours) || endHours < (startHours ?? 0)));
  const save = useMutation({
    mutationFn: async () => {
      if (!vehicle || !date || invalid || (endKm === null && endHours === null)) {
        throw Error("Проверьте дату и конечные показания");
      }
      const response = await fetch("/api/duty/readings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vehicleId: vehicle.id, date,
          startKm: vehicle.currentMileage, startHours,
          endKm, endHours,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw Error(body?.error ?? "Показания не сохранены");
      }
    },
    onSuccess: async () => {
      setKm("");
      setHours("");
      setSaved(true);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["vehicles"] }),
        client.invalidateQueries({ queryKey: ["exploitation"] }),
      ]);
      const fresh = client.getQueryData<VehicleDto[]>(["vehicles"]);
      if (fresh) setState(s => ({ ...s, vehicles: fresh.map(vehicleFromDto) }));
      toast.success("Показания сохранены");
    },
    onError: e => {
      toast.error(e.message);
      void client.invalidateQueries({ queryKey: ["vehicles"] });
    },
  });

  return (
    <Panel className="flex h-[calc(100dvh-3rem)] min-h-0 flex-col overflow-hidden rounded-lg border-[#e2e2e2]">
      <header className="border-b px-6 py-4">
        <div className={label}>Учёт показаний пробега и моточасов</div>
        <h1 className="mt-1 text-base font-semibold">Дежурный по парку</h1>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[min(340px,38%)] shrink-0 flex-col border-r">
          <div className="border-b p-4">
            <Input aria-label="Поиск машины" placeholder="Поиск по марке или гос. номеру..." value={query} onChange={e => setQuery(e.target.value)} />
          </div>
          <div className="overflow-auto">
            {shown.map(v => (
              <button key={v.id} disabled={save.isPending} type="button"
                onClick={() => { select(v.id); setKm(""); setHours(""); setSaved(false); }}
                className={`block w-full border-b border-l-2 px-4 py-3 text-left text-sm ${selected === v.id ? "border-l-neutral-900 bg-neutral-100" : "border-l-transparent hover:bg-neutral-50"}`}>
                {v.brand}<span className="mt-1 block text-xs text-neutral-500">{v.regNumber}</span>
              </button>
            ))}
          </div>
        </aside>
        <main className="flex-1 overflow-auto px-6 py-4">
          {vehicle ? (
            <fieldset disabled={save.isPending} className="max-w-md space-y-4">
              <p className="text-sm">Гос. номер: <strong>{vehicle.regNumber}</strong></p>
              <label className="flex items-center justify-between gap-2 rounded-md border border-[#e2e2e2] bg-[#f7f7f7] px-3">
                <span className={label}>Дата выезда</span>
                <Input type="date" className="w-auto border-0 bg-transparent" value={date} onChange={e => setDate(e.target.value)} />
              </label>
              <div className="space-y-1 border-b pb-3">
                <span className={label}>Начальный километраж</span>
                <div className={`${readingBox} bg-[#f7f7f7]`}>{format(vehicle.currentMileage, "км")}</div>
                <p className={hint}>Текущие показания спидометра из перечня ВВСТ</p>
              </div>
              <div className="space-y-1">
                <span className={label}>Начальные моточасы</span>
                <div className={`${readingBox} bg-[#f7f7f7]`}>{startHours === null ? "Не указано" : format(startHours, "моточасов")}</div>
              </div>
              <label className="block space-y-1">
                <span className={label}>Конечный километраж</span>
                <Input type="number" min={vehicle.currentMileage} placeholder="Введите значение" value={km} onChange={e => { setKm(e.target.value); setSaved(false); }} />
              </label>
              <label className="block space-y-1">
                <span className={label}>Конечные моточасы</span>
                <Input type="number" step="any" min={startHours ?? 0} placeholder="Введите значение" value={hours} onChange={e => { setHours(e.target.value); setSaved(false); }} />
                {startHours === null && <span className={`block ${hint}`}>Первое показание станет начальным. Для расчёта наработки нужны два показания.</span>}
              </label>
              <div className="space-y-1">
                <span className={label}>Пройдено за день</span>
                <div className={`${readingBox} min-h-[62px]`}>{format(kmDiff, "км")}</div>
                <p className={hint}>Рассчитывается по начальному и конечному километражу</p>
              </div>
              <div className="space-y-1">
                <span className={label}>Отработано моточасов</span>
                <div className={`${readingBox} min-h-[62px]`}>{format(hoursDiff, "моточасов")}</div>
                <p className={hint}>Рассчитывается по начальным и конечным моточасам</p>
              </div>
              <div className="text-right">
                <Button disabled={save.isPending || fleet.isError || invalid || !date || (!km && !hours)} onClick={() => save.mutate()}>Применить</Button>
              </div>
            </fieldset>
          ) : (
            <p className="text-sm text-neutral-500">{fleet.isPending ? "Загрузка перечня ВВСТ…" : fleet.isError ? "Не удалось загрузить перечень ВВСТ" : "Выберите машину"}</p>
          )}
        </main>
      </div>
      <footer className={`border-t px-6 py-4 ${hint}`} aria-live="polite">
        {saved ? "Показания сохранены" : km || hours ? "Есть изменения" : "Нет изменений"}
      </footer>
    </Panel>
  );
}
