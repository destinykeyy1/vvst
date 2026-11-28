import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button, Field, Input, Modal, PageHeader, Panel, Select, StatCard } from "@/components/ui-kit";
import { PasswordGate } from "@/components/PasswordGate";
import { apiGetCollection } from "@/lib/api";
import { formatRuDate } from "@/lib/logic";
import type { VehicleDto } from "@/lib/types";

export const Route = createFileRoute("/unavailable")({
  component: () => (
    <PasswordGate section="unavailable" title="Недоступные">
      <UnavailablePage />
    </PasswordGate>
  ),
});

const reasons = ["Ремонт", "Техническое обслуживание", "Командировка", "Учения", "Другое"];
const periodOptions = [["all", "Все"], ["active", "Активные"], ["upcoming", "Предстоящие"], ["past", "Прошедшие"]] as const;
const sourceOptions = [["all", "Все"], ["manual", "Вручную"], ["orders", "Из нарядов"]] as const;
const statuses = { active: "Активна", upcoming: "Предстоящая", past: "Прошедшая" };

type EntryFields = {
  vehicleId: number;
  startDate: string;
  endDate: string;
  reason: string;
  customReason?: string | null;
  notes?: string | null;
};
type Entry = EntryFields & { id: number; orderId?: number | null };
type Action =
  | { action: "create"; entry: EntryFields }
  | { action: "update"; id: number; entry: EntryFields }
  | { action: "delete"; ids: number[] };

function localToday() {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}
function matchesVehicle(vehicle: VehicleDto | undefined, query: string) {
  return !query || Boolean(vehicle && `${vehicle.brand} ${vehicle.regNumber}`.toLocaleLowerCase("ru").includes(query.trim().toLocaleLowerCase("ru")));
}
function entryStatus(entry: Entry, today: string) {
  if (entry.endDate < today) return "past";
  return entry.startDate > today ? "upcoming" : "active";
}
async function saveEntry(body: Action) {
  const response = await fetch("/api/unavailable/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Не удалось сохранить запись.");
}

function Filters<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex overflow-hidden rounded-md border">
      {options.map(([key, title]) => (
        <button key={key} type="button" aria-pressed={key === value} onClick={() => onChange(key)}
          className={`px-3 py-2 text-xs ${key === value ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
          {title}
        </button>
      ))}
    </div>
  );
}

function UnavailablePage() {
  const client = useQueryClient();
  const { data: entries = [], isPending, isError } = useQuery({
    queryKey: ["unavailable"],
    queryFn: () => apiGetCollection<Entry>("unavailable"),
  });
  const fleet = useQuery({
    queryKey: ["vehicles"],
    queryFn: () => apiGetCollection<VehicleDto>("vehicles"),
  });
  const vehicles = fleet.data ?? [];
  const byId = new Map(vehicles.map(vehicle => [vehicle.id, vehicle]));
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState<(typeof periodOptions)[number][0]>("all");
  const [source, setSource] = useState<(typeof sourceOptions)[number][0]>("all");
  const [editor, setEditor] = useState<Entry | "new" | null>(null);
  const [selection, setSelection] = useState<number[]>([]);
  const [deleting, setDeleting] = useState<number[]>([]);
  const mutation = useMutation({
    mutationFn: saveEntry,
    onSuccess: async (_, action) => {
      await client.invalidateQueries({ queryKey: ["unavailable"] });
      setEditor(null);
      setDeleting([]);
      setSelection([]);
      toast.success(action.action === "create" ? "Запись добавлена" :
        action.action === "update" ? "Запись обновлена" : "Записи удалены");
    },
    onError: error => toast.error(error instanceof Error ? error.message : "Ошибка сохранения"),
  });
  const today = localToday();
  const active = entries.filter(entry => entryStatus(entry, today) === "active");
  const results = entries.filter(entry =>
    matchesVehicle(byId.get(entry.vehicleId), query) &&
    (period === "all" || period === entryStatus(entry, today)) &&
    (source === "all" || (entry.orderId == null ? "manual" : "orders") === source),
  ).sort((a, b) => b.startDate.localeCompare(a.startDate) || b.id - a.id);
  const manualIds = results.filter(entry => entry.orderId == null).map(entry => entry.id);
  const visibleSelection = manualIds.filter(id => selection.includes(id));
  const allSelected = manualIds.length > 0 && visibleSelection.length === manualIds.length;
  const closeEditor = () => { if (!mutation.isPending) setEditor(null); };
  return (
    <div>
      <PageHeader title="НЕДОСТУПНЫЕ" subtitle="Машины, временно недоступные к выезду"
        actions={<Button disabled={isError || isPending} onClick={() => setEditor("new")}>
          <Plus className="mr-2 h-4 w-4" />Добавить запись
        </Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="ВСЕГО ЗАПИСЕЙ" value={entries.length} />
        <StatCard label="АКТИВНЫ СЕГОДНЯ" value={active.length} />
        <StatCard label="В РЕМОНТЕ" value={<span className="text-destructive">{active.filter(e => e.reason === "Ремонт").length}</span>} />
        <StatCard label="В НАРЯДАХ" value={active.filter(e => e.orderId != null).length} />
      </div>
      <Panel className="mb-4 flex flex-wrap items-center gap-2 p-3">
        <Input className="min-w-48 flex-1" aria-label="Поиск по марке или гос. номеру"
          placeholder="Поиск по марке или гос. номеру..." value={query} onChange={e => setQuery(e.target.value)} />
        <Filters label="Период" options={periodOptions} value={period} onChange={setPeriod} />
        <Filters label="Источник" options={sourceOptions} value={source} onChange={setSource} />
        {!!visibleSelection.length && <Button variant="outline" size="sm" onClick={() => setDeleting(visibleSelection)}>
          Удалить выбранные ({visibleSelection.length})
        </Button>}
      </Panel>
      <Panel className="overflow-x-auto">
        {results.length > 0 ? (
          <table className="w-full min-w-[780px] text-left text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="w-10 p-3"><input type="checkbox" aria-label="Выбрать все видимые ручные записи"
                  disabled={!manualIds.length} checked={allSelected}
                  onChange={() => setSelection(allSelected ? [] : manualIds)} /></th>
                {["Машина", "Источник", "Причина", "Период", "Дней", "Статус", "Действия"].map(label =>
                  <th key={label} scope="col" className="p-3 font-normal">{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {results.map(entry => {
                const vehicle = byId.get(entry.vehicleId);
                const status = entryStatus(entry, today);
                const days = Math.round((Date.parse(entry.endDate) - Date.parse(entry.startDate)) / 86400000) + 1;
                const manual = entry.orderId == null;
                return (
                  <tr key={entry.id} className="border-t bg-muted/30">
                    <td className="p-3"><input type="checkbox" aria-label="Выбрать запись"
                      disabled={!manual} checked={selection.includes(entry.id)}
                      onChange={e => setSelection(e.target.checked ? [...selection, entry.id] : selection.filter(id => id !== entry.id))} /></td>
                    <td className="p-3">{vehicle?.brand ?? `Машина № ${entry.vehicleId}`}
                      {vehicle && <div className="text-xs text-muted-foreground">{vehicle.regNumber} · {vehicle.usageType}</div>}
                    </td>
                    <td className="p-3 text-muted-foreground">{manual ? "Вручную" : "Из наряда"}</td>
                    <td className="p-3">{entry.reason === "Другое" ? entry.customReason || entry.reason : entry.reason}
                      {entry.notes && <div className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{entry.notes}</div>}
                    </td>
                    <td className="whitespace-nowrap p-3">{formatRuDate(entry.startDate)}
                      {entry.startDate !== entry.endDate && ` — ${formatRuDate(entry.endDate)}`}
                    </td>
                    <td className="p-3">{days}</td>
                    <td className="p-3"><span className={`rounded px-2 py-1 text-xs ${status === "active" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                      {statuses[status]}
                    </span></td>
                    <td className="whitespace-nowrap p-3 text-right text-xs">{manual && <>
                      <button type="button" className="mr-3 hover:underline" onClick={() => setEditor(entry)}>Изменить</button>
                      <button type="button" className="text-destructive hover:underline" onClick={() => setDeleting([entry.id])}>Удалить</button>
                    </>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground" role="status">
            {isPending ? "Загрузка записей…" : isError ? "Не удалось загрузить записи." :
              entries.length ? "По этим фильтрам записей нет" : "Записей о недоступности нет"}
          </p>
        )}
      </Panel>
      {editor && <EntryEditor entry={editor === "new" ? undefined : editor} vehicles={vehicles} today={today}
        loading={fleet.isPending} failed={fleet.isError} saving={mutation.isPending} close={closeEditor}
        save={entry => mutation.mutate(editor === "new" ? { action: "create", entry } : { action: "update", id: editor.id, entry })} />}
      <Modal open={deleting.length > 0} title="Удалить записи?" onClose={() => { if (!mutation.isPending) setDeleting([]); }}
        size="sm" footer={<>
          <Button variant="outline" disabled={mutation.isPending} onClick={() => setDeleting([])}>Отмена</Button>
          <Button disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "delete", ids: deleting })}>Удалить</Button>
        </>}>
        <p>Записей к удалению: {deleting.length}.</p>
      </Modal>
    </div>
  );
}

function EntryEditor({ entry, vehicles, today, loading, failed, saving, close, save }: {
  entry?: Entry; vehicles: VehicleDto[]; today: string; loading: boolean; failed: boolean;
  saving: boolean; close: () => void; save: (fields: EntryFields) => void;
}) {
  const [query, setQuery] = useState("");
  const [fields, setFields] = useState<EntryFields>({
    vehicleId: entry?.vehicleId ?? 0, startDate: entry?.startDate ?? today, endDate: entry?.endDate ?? today,
    reason: entry?.reason ?? reasons[0], customReason: entry?.customReason ?? "", notes: entry?.notes ?? "",
  });
  const change = (values: Partial<EntryFields>) => setFields(current => ({ ...current, ...values }));
  const vehicle = vehicles.find(item => item.id === fields.vehicleId);
  const valid = vehicle && fields.startDate && fields.endDate && fields.endDate >= fields.startDate &&
    (fields.reason !== "Другое" || fields.customReason?.trim());
  return (
    <Modal open title={entry ? "Редактирование записи" : "Новая запись"} eyebrow="Отметка о недоступности" size="lg" onClose={close}
      footer={<>
        <Button variant="outline" disabled={saving} onClick={close}>Отмена</Button>
        <Button disabled={saving || !valid} onClick={() => save({
          ...fields, notes: fields.notes?.trim() || null,
          customReason: fields.reason === "Другое" ? fields.customReason?.trim() : null,
        })}>{entry ? "Сохранить" : "Добавить"}</Button>
      </>}>
      <div className="-mx-6 -my-5 grid min-h-[min(60vh,38rem)] sm:grid-cols-[20rem_1fr]">
        <div className="border-b sm:border-b-0 sm:border-r">
          <div className="border-b p-4">
            <Field label="Машина"><Input placeholder="Поиск..." value={query} onChange={e => setQuery(e.target.value)} /></Field>
          </div>
          <div className="thin-scroll max-h-[min(52vh,33rem)] overflow-y-auto">
            {vehicles.filter(item => matchesVehicle(item, query)).map(item =>
              <button key={item.id} type="button" aria-pressed={item.id === fields.vehicleId}
                disabled={saving} onClick={() => change({ vehicleId: item.id })}
                className={`block w-full border-b px-4 py-3 text-left text-sm hover:bg-muted ${item.id === fields.vehicleId ? "bg-muted" : ""}`}>
                {item.brand}<div className="text-xs text-muted-foreground">{item.regNumber} · {item.usageType}</div>
              </button>)}
            {!vehicles.some(item => matchesVehicle(item, query)) && (
              <p className="p-4 text-sm text-muted-foreground">
                {loading ? "Загрузка машин…" : failed ? "Не удалось загрузить перечень." : "Машины не найдены."}
              </p>
            )}
          </div>
        </div>
        {vehicle ? (
          <div className="w-full max-w-[31rem] space-y-4 p-6">
            <div>
              <p className="text-xs uppercase text-muted-foreground">{[vehicle.usageType, vehicle.location].filter(Boolean).join(" · ")}</p>
              <h2 className="mt-1 font-semibold">{vehicle.brand}</h2>
              <p className="mt-1 text-sm">Гос. номер <strong>{vehicle.regNumber}</strong></p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Дата начала"><Input type="date" value={fields.startDate} disabled={saving}
                onChange={e => change({ startDate: e.target.value })} /></Field>
              <Field label="Дата окончания"><Input type="date" min={fields.startDate} value={fields.endDate} disabled={saving}
                onChange={e => change({ endDate: e.target.value })} /></Field>
            </div>
            {fields.startDate && fields.endDate && fields.endDate < fields.startDate &&
              <p role="alert" className="text-sm text-destructive">Дата окончания раньше даты начала.</p>}
            <Field label="Причина"><Select value={fields.reason} disabled={saving} onChange={e => change({ reason: e.target.value })}>
              {reasons.map(reason => <option key={reason}>{reason}</option>)}
            </Select></Field>
            {fields.reason === "Другое" && <Field label="Уточните причину"><Input value={fields.customReason ?? ""}
              disabled={saving} onChange={e => change({ customReason: e.target.value })} /></Field>}
            <Field label="Примечание (необязательно)"><textarea rows={3} disabled={saving}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={fields.notes ?? ""} onChange={e => change({ notes: e.target.value })} /></Field>
          </div>
        ) : (
          <p className="p-6 pt-16 text-center text-sm text-muted-foreground">
            Выберите машину из списка, чтобы указать период недоступности.
          </p>
        )}
      </div>
    </Modal>
  );
}
