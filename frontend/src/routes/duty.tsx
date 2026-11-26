import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Field, Input, Panel } from "@/components/ui-kit";
import { apiGetCollection, apiSaveMileage } from "@/lib/api";
import { setState, useAppState } from "@/lib/store";
import { vehicleFromDto } from "@/lib/backendMap";
import type { JournalEntry, VehicleDto } from "@/lib/types";
import { toast } from "sonner";

export const Route = createFileRoute("/duty")({ component: DutyPage });
const hourField = "Текущие показания МОТОЧАСОВ";
function hoursOf(vehicle?: VehicleDto) {
  const value = vehicle?.passportData?.find(p => p.header === hourField)?.value;
  if (value == null || String(value).trim() === "") return null;
  const hours = Number(String(value).replace(",", "."));
  return Number.isFinite(hours) ? hours : null;
}

function DutyPage() {
  const vehicles = useAppState(s => s.vehicles);
  const [query, setQuery] = useState("");
  const [selected, select] = useState<number>();
  const [km, setKm] = useState("");
  const [hours, setHours] = useState("");
  const [date, setDate] = useState(new Date().toLocaleDateString("sv-SE"));
  const shown = vehicles.filter(v => (v.brand + " " + v.plate).toLowerCase().includes(query.trim().toLowerCase()));
  const vehicle = vehicles.find(v => v.id === selected);
  const startHours = hoursOf(vehicle?.rawDto);
  const kmDiff = vehicle && km ? Number(km) - vehicle.mileage : null;
  const hoursDiff = startHours !== null && hours ? Number(hours) - startHours : null;
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: async () => {
      if (!vehicle || !date || (!km && !hours)) throw Error("Введите конечные показания");
      const [fleet, journal, history] = await Promise.all([apiGetCollection<VehicleDto>("vehicles"), apiGetCollection<JournalEntry>("journal"), apiGetCollection("exploitation")]);
      const current = fleet.find(v => v.id === vehicle.id);
      if (!current || current.currentMileage !== vehicle.mileage || hoursOf(current) !== startHours) throw Error("Показания изменились. Обновите страницу.");
      if (km && (!Number.isInteger(Number(km)) || Number(km) < current.currentMileage) || hours && (!Number.isFinite(Number(hours)) || Number(hours) < (startHours ?? 0))) throw Error("Проверьте конечные показания");
      const updated = { ...current, currentMileage: km ? Number(km) : current.currentMileage, passportData: [...(current.passportData ?? [])] };
      if (hours) {
        const index = updated.passportData.findIndex(p => p.header === hourField);
        const previous = updated.passportData[index];
        if (previous) updated.passportData[index] = { ...previous, value: Number(hours) };
        else updated.passportData.push({ header: hourField, value: Number(hours), column: Math.max(0, ...updated.passportData.map(p => p.column)) + 1 });
      }
      const next = fleet.map(v => v.id === updated.id ? updated : v);
      const record = { date, vehicleId: updated.id, km: kmDiff ?? 0, ...(hoursDiff === null ? {} : { engineHours: hoursDiff }) };
      await apiSaveMileage({ vehicles: next, journal, exploitation: kmDiff || hoursDiff ? [...history, record] : history });
      return next;
    },
    onSuccess: fleet => { setState(s => ({ ...s, vehicles: fleet.map(vehicleFromDto) })); client.invalidateQueries({ queryKey: ["exploitation"] }); setKm(""); setHours(""); toast.success("Показания сохранены"); },
    onError: e => toast.error(e.message),
  });
  return <Panel className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden rounded-lg">
    <header className="border-b px-6 py-4"><div className="eyebrow">Учёт показаний пробега и моточасов</div><h1 className="mt-1 font-semibold">Дежурный по парку</h1></header>
    <div className="flex min-h-0 flex-1"><aside className="flex w-[min(340px,38%)] flex-col border-r"><div className="border-b p-4"><Input aria-label="Поиск машины" placeholder="Поиск по марке или гос. номеру..." value={query} onChange={e => setQuery(e.target.value)} /></div><div className="overflow-auto">{shown.map(v => <button key={v.id} disabled={save.isPending} onClick={() => { select(v.id); setKm(""); setHours(""); }} className={"block w-full border-b border-l-2 px-4 py-3 text-left text-sm " + (selected === v.id ? "border-l-neutral-900 bg-neutral-100" : "border-l-transparent")}>{v.brand}<span className="block text-xs text-neutral-500">{v.plate}</span></button>)}</div></aside>
      <main className="flex-1 overflow-auto p-6">{vehicle ? <fieldset disabled={save.isPending} className="max-w-md space-y-4"><Field label="Дата выезда"><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
        <Field label="Начальный километраж"><Input readOnly value={vehicle.mileage.toLocaleString("ru-RU") + " км"} /></Field>
        <Field label="Начальные моточасы"><Input readOnly value={startHours ?? "Не указано"} /></Field>
        <Field label="Конечный километраж"><Input type="number" min={vehicle.mileage} value={km} onChange={e => setKm(e.target.value)} /></Field>
        <Field label="Конечные моточасы"><Input type="number" step="any" min={startHours ?? 0} value={hours} onChange={e => setHours(e.target.value)} /></Field>
        <Field label="Пройдено за день"><Input readOnly value={kmDiff ?? "—"} /></Field><Field label="Отработано моточасов"><Input readOnly value={hoursDiff ?? "—"} /></Field>
        <div className="text-right"><Button disabled={(!hours && !km) || !date || (kmDiff ?? 0) < 0 || (hoursDiff ?? 0) < 0} onClick={() => save.mutate()}>Применить</Button></div></fieldset> : "Выберите машину"}</main></div>
  </Panel>;
}
