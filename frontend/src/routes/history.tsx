import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Edit, Trash2 } from "lucide-react";
import { Button, Field, Input, Modal, PageHeader, Panel, Select } from "@/components/ui-kit";
import { apiGetCollection, apiPutCollection } from "@/lib/api";
import type { VehicleDto } from "@/lib/types";
import { useState, useMemo } from "react";
import { toast } from "sonner";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

interface ExploitationItem {
  vehicleId: number;
  date: string;
  km: number;
  engineHours?: number | null;
  orderId?: number | null;
  journalEntryId?: number | null;
}

export const Route = createFileRoute("/history")({
  component: HistoryPage,
});

const EMPTY: ExploitationItem = { vehicleId: 0, date: "", km: 0, engineHours: null };

function HistoryPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [formData, setFormData] = useState<ExploitationItem>(EMPTY);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);

  const { data: fleet = [] } = useQuery({
    queryKey: ["vehicles"],
    queryFn: () => apiGetCollection<VehicleDto>("vehicles"),
    refetchOnMount: "always",
  });
  const vehicles = fleet.map(vehicle => ({ ...vehicle, plate: vehicle.regNumber }));
  const vehicleName = (id: number) => {
    const v = vehicles.find((x) => x.id === id);
    return v ? `${v.brand} (${v.plate})` : `ID ${id}`;
  };

  const queryClient = useQueryClient();

  const { data: items = [] } = useQuery({
    queryKey: ["exploitation"],
    queryFn: () => apiGetCollection<ExploitationItem>("exploitation"),
  });

  const saveMutation = useMutation({
    mutationFn: async (data: ExploitationItem[]) => apiPutCollection("exploitation", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["exploitation"] });
      setModalOpen(false);
      setEditingIndex(null);
      setFormData(EMPTY);
      toast.success("Сохранено");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Ошибка сохранения"),
  });

  const handleAdd = () => {
    setEditingIndex(null);
    setFormData({ ...EMPTY, date: new Date().toISOString().slice(0, 10), vehicleId: vehicles[0]?.id ?? 0 });
    setModalOpen(true);
  };

  const handleEdit = (index: number) => {
    setEditingIndex(index);
    setFormData({ ...EMPTY, ...items[index] });
    setModalOpen(true);
  };

  const handleDelete = (index: number) => {
    setDeleteTarget(index);
    setDeleteOpen(true);
  };

  const performDelete = () => {
    if (deleteTarget === null) return;
    saveMutation.mutate(items.filter((_, i) => i !== deleteTarget));
    setDeleteOpen(false);
    setDeleteTarget(null);
  };

  const handleSave = () => {
    if (!formData.vehicleId || !formData.date || formData.km < 0) {
      toast.error("Заполните машину, дату и пробег");
      return;
    }
    const newItem: ExploitationItem = {
      vehicleId: Number(formData.vehicleId),
      date: formData.date,
      km: Math.trunc(Number(formData.km)),
      engineHours: formData.engineHours === null || formData.engineHours === undefined || formData.engineHours === ("" as never) ? null : Number(formData.engineHours),
    };
    const updated = editingIndex === null ? [...items, newItem] : items.map((it, i) => (i === editingIndex ? newItem : it));
    saveMutation.mutate(updated);
  };

  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [search, setSearch] = useState("");
  const [day, setDay] = useState<{ vehicleId: number; date: string } | null>(null);
  const months = Array.from({ length: 12 }, (_, i) => new Date(year, i).toLocaleString("ru-RU", { month: "long" }));
  const prefix = month ? [year, String(month).padStart(2, "0")].join("-") : String(year);
  const visible = vehicles.filter(v => vehicleName(v.id).toLowerCase().includes(search.trim().toLowerCase()));
  const ids = new Set(visible.map(v => v.id));
  const records = items.filter(r => r.date.startsWith(prefix) && ids.has(r.vehicleId));
  type Reading = { km: number; hours: number | null };
  const daily = new Map<string, Reading>();
  const totals = new Map<number, Reading>();
  function add(previous: Reading | undefined, record: ExploitationItem): Reading {
    return { km: (previous?.km ?? 0) + record.km, hours: record.engineHours == null ? previous?.hours ?? null : (previous?.hours ?? 0) + record.engineHours };
  }
  for (const record of records) {
    const key = record.vehicleId + "/" + record.date.slice(0, month ? 10 : 7);
    daily.set(key, add(daily.get(key), record));
    totals.set(record.vehicleId, add(totals.get(record.vehicleId), record));
  }
  const formatReading = (r: Reading) => r.km.toLocaleString("ru-RU") + (r.hours == null ? "" : " / " + r.hours.toLocaleString("ru-RU"));
  const todayColumn = (day: number) => month === today.getMonth() + 1 && year === today.getFullYear() && day === today.getDate() ? "border-x-2 border-neutral-900" : "";
  const total = records.reduce((sum, r) => sum + r.km, 0);
  const hours = records.reduce((sum, r) => sum + (r.engineHours ?? 0), 0);
  const columns = Array.from({ length: month ? new Date(year, month, 0).getDate() : 12 }, (_, i) => i + 1);
  const sorted = day ? records.filter(r => r.vehicleId === day.vehicleId && r.date.startsWith(day.date)) : [];
  const toChart = (list: typeof items) => {
    const byDate = new Map<string, { date: string; km: number; moto: number | null }>();
    for (const r of list) {
      const cur = byDate.get(r.date) ?? { date: r.date.slice(5), km: 0, moto: null };
      cur.km += r.km;
      if (r.engineHours != null) cur.moto = (cur.moto ?? 0) + r.engineHours;
      byDate.set(r.date, cur);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  };
  const dayChartData = useMemo(() => toChart(sorted), [sorted]);
  return (
    <div>
      <PageHeader title="История эксплуатации" subtitle={month ? "Пробег техники по дням за " + months[month - 1] : "Пробег техники по дням за весь выбранный год"} />
      <Panel className="mb-4 flex flex-wrap items-center gap-3 rounded-lg p-3">
        <span className="eyebrow">Год</span>
        <Button variant="outline" aria-label="Предыдущий год" onClick={() => setYear(year - 1)}>‹</Button>
        <span className="min-w-[160px] rounded-md border bg-neutral-50 px-4 py-2 text-center text-sm font-medium">{year}</span>
        <Button variant="outline" aria-label="Следующий год" onClick={() => setYear(year + 1)}>›</Button>
        <label className="flex items-center gap-2"><span className="eyebrow">Месяц</span><Select value={month} onChange={e => setMonth(Number(e.target.value))}><option value={0}>Весь год</option>{months.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select></label>
        <Button variant="outline" onClick={() => { setYear(today.getFullYear()); setMonth(today.getMonth() + 1); }}>Текущий месяц</Button>
        <Input className="min-w-[220px] flex-1" aria-label="Поиск по марке или гос. номеру" placeholder="Поиск по марке или гос. номеру..." value={search} onChange={e => setSearch(e.target.value)} />
        <Button onClick={handleAdd}><Plus size={16} />Добавить запись</Button>
      </Panel>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {Object.entries({ "Всего машин": visible.length, "С выездами": new Set(records.map(r => r.vehicleId)).size, "Общий пробег / моточасы": total.toLocaleString("ru-RU") + " км / " + hours.toLocaleString("ru-RU") + " мч", "Средний на машину": Math.round(total / (new Set(records.map(r => r.vehicleId)).size || 1)) + " км" }).map(([label, value]) => <Panel key={label} className="rounded-lg px-4 py-3"><div className="eyebrow">{label}</div><div className="mt-1 text-xl font-semibold">{value}</div></Panel>)}
      </div>
      <Panel className="overflow-auto rounded-lg">
        <table className="w-full border-collapse text-center text-xs">
          <thead className="bg-neutral-50"><tr><th className="sticky left-0 bg-neutral-50 p-3 text-left font-normal">МАШИНА</th>{columns.map(i => <th key={i} className={"min-w-12 px-2 py-3 font-medium " + todayColumn(i)}>{month ? String(i).padStart(2, "0") : months[i - 1]}{month > 0 && <span className="block text-[10px] font-normal uppercase text-neutral-500">{new Date(year, month - 1, i).toLocaleDateString("ru-RU", { weekday: "short" })}</span>}</th>)}<th className="px-3 font-normal">ИТОГО</th></tr></thead>
          <tbody>{visible.map(v => <tr key={v.id} className="border-t"><th className="sticky left-0 whitespace-nowrap bg-white px-3 py-2 text-left font-normal">{v.brand}<span className="block text-xs text-neutral-500">{v.plate}</span></th>{columns.map(i => {
            const date = prefix + "-" + String(i).padStart(2, "0");
            const reading = daily.get(v.id + "/" + date);
            return <td key={date} className={todayColumn(i) + (month && [0, 6].includes(new Date(year, month - 1, i).getDay()) ? " bg-neutral-50" : "")}>{reading === undefined ? <span className="text-neutral-300">—</span> : <button className="w-full bg-neutral-100 p-2 font-semibold hover:bg-neutral-200" onClick={() => setDay({ vehicleId: v.id, date })}>{formatReading(reading)}</button>}</td>;
          })}<td className="border-l px-3 text-right">{formatReading(totals.get(v.id) ?? { km: 0, hours: null })} {totals.get(v.id)?.hours != null ? "км / ч" : "км"}</td></tr>)}</tbody>
        </table>
      </Panel>
      <Modal open={day !== null && !modalOpen && !deleteOpen} onClose={() => setDay(null)} title={day ? vehicleName(day.vehicleId) + " · " + day.date : ""} size="lg">
      {dayChartData.length > 1 && (
        <Panel className="mb-4 p-4">
          <h3 className="mb-3 text-sm font-semibold">Наработка: км / моточасы</h3>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={dayChartData} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" fontSize={11} />
                <YAxis yAxisId="km" fontSize={11} tickFormatter={(v: number) => v.toLocaleString("ru-RU")} />
                <YAxis yAxisId="moto" orientation="right" fontSize={11} />
                <Tooltip />
                <Legend />
                <Bar yAxisId="km" dataKey="km" name="Пробег, км" fill="#2563eb" radius={[3, 3, 0, 0]} />
                <Line yAxisId="moto" dataKey="moto" name="Моточасы" stroke="#dc2626" dot={{ r: 2 }} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      )}

      <Panel className="thin-scroll max-h-[calc(100vh-20rem)] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr className="border-b border-border">
              <th className="px-3 py-3 text-left">Дата</th>
              <th className="px-3 py-3 text-left">Машина</th>
              <th className="px-3 py-3 text-right">Пробег, км</th>
              <th className="px-3 py-3 text-right">Моточасы</th>
              <th className="w-24 px-3 py-3 text-center">Действия</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-20 text-center text-muted-foreground">Записей нет</td>
              </tr>
            ) : (
              sorted.map((item, idx) => (
                <tr key={idx} className="border-b border-border">
                  <td className="px-3 py-3">{item.date}</td>
                  <td className="px-3 py-3">{vehicleName(item.vehicleId)}</td>
                  <td className="px-3 py-3 text-right">{item.km.toLocaleString("ru-RU")}</td>
                  <td className="px-3 py-3 text-right">{item.engineHours ?? "—"}</td>
                  <td className="px-3 py-3 text-center">
                    <div className="flex justify-center gap-2">
                      <button className="text-muted-foreground hover:text-foreground" onClick={() => handleEdit(items.indexOf(item))}>
                        <Edit className="h-4 w-4" />
                      </button>
                      <button className="text-muted-foreground hover:text-destructive" onClick={() => handleDelete(items.indexOf(item))}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>

      </Modal>
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingIndex === null ? "Добавить запись" : "Редактировать запись"}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setModalOpen(false)}>Отмена</Button>
            <Button onClick={handleSave} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Сохранение..." : "Сохранить"}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="Машина">
            <Select value={formData.vehicleId} onChange={(e) => setFormData({ ...formData, vehicleId: Number(e.target.value) })}>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>{v.brand} — {v.plate}</option>
              ))}
            </Select>
          </Field>
          <Field label="Дата">
            <Input type="date" value={formData.date} onChange={(e) => setFormData({ ...formData, date: e.target.value })} />
          </Field>
          <Field label="Пробег, км">
            <Input type="number" min={0} value={formData.km} onChange={(e) => setFormData({ ...formData, km: Number(e.target.value) })} />
          </Field>
          <Field label="Моточасы">
            <Input type="number" min={0} step="0.1" value={formData.engineHours ?? ""} onChange={(e) => setFormData({ ...formData, engineHours: e.target.value === "" ? null : Number(e.target.value) })} />
          </Field>
        </div>
      </Modal>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Подтверждение удаления"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>Отмена</Button>
            <Button variant="danger" onClick={performDelete}>Удалить</Button>
          </>
        }
      >
        <p className="text-sm">Вы уверены, что хотите удалить эту запись? Это действие нельзя отменить.</p>
      </Modal>
    </div>
  );
}
