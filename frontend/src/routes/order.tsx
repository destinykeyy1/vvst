import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Download, FileText } from "lucide-react";
import { Button, Field, Input, Modal, PageHeader, Panel } from "@/components/ui-kit";
import { PasswordGate } from "@/components/PasswordGate";
import { apiGetCollection, apiPutCollection, type ScheduleItem } from "@/lib/api";
import { readExcelRows, pickString } from "@/lib/excel";
import { useAppState } from "@/lib/store";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

import { orderTabs, type OrderTab } from "@/lib/orderTabs";

interface OrderLine {
  id: number;
  section: string;
  brand: string;
  regNumber: string;
  usageGroup: string;
  driver: string;
  route: string;
  purpose: string;
  departureTime: string;
  returnTime: string;
  responsible: string;
  note: string;
  date?: string;
  scheduleRowId?: number;
}

export const Route = createFileRoute("/order")({
  validateSearch: (search: Record<string, unknown>): { tab?: OrderTab } => {
    const tab = orderTabs.find((entry) => entry.key === search["tab"]);
    return tab ? { tab: tab.key } : {};
  },
  component: () => (
    <PasswordGate section="order" title="Наряд">
      <OrderRoute />
    </PasswordGate>
  ),
});

function OrderRoute() {
  const { tab } = Route.useSearch();
  return tab ? <OrderPage key={tab} /> : <OrderArchive />;
}

function OrderArchive() {
  type Order = { id: number; orderNumber: string | number; date: string; lines: OrderLine[] };
  const drafts = useQuery({ queryKey: ["order-drafts"], queryFn: () => apiGetCollection<{ id: number; date: string }>("order-drafts") });
  const orders = useQuery({ queryKey: ["orders"], queryFn: () => apiGetCollection<Order>("orders") });
  const [opened, setOpened] = useState<Order | null>(null);
  return <div><PageHeader title="Наряд" subtitle="Подготовьте строки и подтвердите итоговую публикацию здесь." />
    <h2 className="mb-3 text-sm font-semibold">Подготовленные наряды</h2>
    <div className="rounded-lg border border-dashed p-8 text-center text-sm text-neutral-500">{drafts.isLoading ? "Загрузка…" : drafts.isError ? "Не удалось загрузить подготовленные наряды" : drafts.data?.length ? drafts.data.map(d => <p key={d.id}>Черновик от {d.date}</p>) : "Подготовленных нарядов пока нет. Перенесите строки из нужных подразделов."}</div>
    <h2 className="mb-3 mt-8 text-sm font-semibold">Опубликованные наряды</h2>
    {orders.isLoading && "Загрузка…"}{orders.isError && "Не удалось загрузить наряды"}
    {orders.data?.map(order => <Panel key={order.id} className="mb-3 flex items-center justify-between rounded-lg p-4"><div className="text-sm"><strong>Наряд №{order.orderNumber} от {order.date.split("-").reverse().join(".")}</strong> <span className="rounded border px-2 text-xs">Опубликован</span><div className="mt-1 text-xs text-neutral-500">{order.lines.length} строк</div></div><Button variant="outline" onClick={() => setOpened(order)}>Показать наряд</Button></Panel>)}
    <Modal open={!!opened} onClose={() => setOpened(null)} title={"Наряд №" + (opened?.orderNumber ?? "")}><table className="w-full text-left text-sm"><thead><tr><th>Марка</th><th>Регистрационный знак</th></tr></thead><tbody>{opened?.lines.map((line,i) => <tr key={i}><td>{line.brand}</td><td>{line.regNumber}</td></tr>)}</tbody></table></Modal></div>;
}

type TrainingDraft = { id: number; date: string; lines: OrderLine[] };

function eligibleTrainingVehicle(vehicle: { brand: string; plate: string; group?: string }) {
  const plate = vehicle.plate.trim();
  const number = plate.replace(/^\s*№\s*/, "").match(/^\d+/)?.[0];
  const group = (vehicle.group ?? "").toUpperCase().replace(/[^А-ЯЁA-Z]/g, "");
  return Boolean(plate) && group !== "СШ" && !group.startsWith("СВЕРХШТАТ") &&
    !(/(?:БМП|BMP)/i.test(vehicle.brand) && number !== undefined && Number(number) >= 400);
}

function trainingRoute(route: string) {
  const value = route.trim();
  return /^[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*$/u.test(value) && !/^парк$/i.test(value)
    ? `парк - ${value} - парк`
    : value;
}

function overlaps(a: OrderLine, b: OrderLine) {
  if (!a.departureTime || !a.returnTime || !b.departureTime || !b.returnTime) return true;
  return a.departureTime < b.returnTime && b.departureTime < a.returnTime;
}

function OrderPage() {
  const { tab: activeTab = "duty" } = Route.useSearch();

  const [selectedDate, setSelectedDate] = useState(() =>
    new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Omsk" }),
  );
  const [picking, setPicking] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const training = activeTab === "training";
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Set<number> | null>(null);

  const queryClient = useQueryClient();

  const { data: lines = [], isLoading } = useQuery({
    queryKey: ["order-section-lines"],
    queryFn: () => apiGetCollection<OrderLine>("order-section-lines"),
  });

  const filteredLines = lines.filter((line) => line.section === activeTab &&
    (!training || line.date === selectedDate));

  const saveMutation = useMutation({
    mutationFn: async (data: OrderLine[]) => {
      return apiPutCollection("order-section-lines", data);
    },
    onSuccess: async (_, updated) => {
      queryClient.setQueryData(["order-section-lines"], updated);
      await queryClient.invalidateQueries({ queryKey: ["order-section-lines"] });
      toast.success("Сохранено");
    },
    onError: () => {
      toast.error("Ошибка сохранения");
    },
  });

  const handleAddRow = () => {
    const newLine: OrderLine = {
      id: Date.now(),
      section: activeTab,
      brand: "",
      regNumber: "",
      usageGroup: "",
      driver: "",
      route: "",
      purpose: "",
      departureTime: "",
      returnTime: "",
      responsible: "",
      note: "",
      date: selectedDate,
    };
    const updated = [...lines, newLine];
    saveMutation.mutate(updated);
  };

  const handleDeleteSelected = () => {
    if (selectedRows.size === 0) return;
    setDeleteTarget(selectedRows);
    setDeleteOpen(true);
  };

  const performDelete = () => {
    if (!deleteTarget) return;
    const updated = lines.filter((line) => !deleteTarget.has(line.id));
    saveMutation.mutate(updated);
    setSelectedRows(new Set());
    setDeleteOpen(false);
    setDeleteTarget(null);
  };

  const handleCellEdit = (id: number, field: keyof OrderLine, value: string) => {
    const updated = lines.map((line) =>
      line.id === id ? { ...line, [field]: value } : line
    );
    saveMutation.mutate(updated);
  };

  const toggleRowSelection = (id: number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllRows = () => {
    if (selectedRows.size === filteredLines.length) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(filteredLines.map((l) => l.id)));
    }
  };

  const allSelected = filteredLines.length > 0 && selectedRows.size === filteredLines.length;

  const vehicles = useAppState((s) => s.vehicles);

  const SCHEDULE_COLLECTION: Partial<Record<OrderTab, string>> = {
    training: "schedules",
    household: "household-schedules",
    other: "other-schedules",
  };

  const trainingVehicles = vehicles.filter(eligibleTrainingVehicle);
  const busy = isLoading || picking || transferring || saveMutation.isPending;
  const today = selectedDate.split("-").reverse().join(".");

  const handleTrainingAutopick = async () => {
    if (busy || !selectedDate) return;
    setPicking(true);
    try {
      const items = await apiGetCollection<ScheduleItem>("schedules");
      const latest = queryClient.getQueryData<OrderLine[]>(["order-section-lines"]);
      if (!latest) throw new Error("Не удалось загрузить строки наряда");
      const schedule = items.filter(item => item.date === selectedDate ||
        item.scheduleDates?.includes(selectedDate));
      const picked: OrderLine[] = [];
      const reserved = latest.filter(row => row.section !== activeTab && row.date === selectedDate);
      let id = latest.reduce((max, row) => Math.max(max, row.id), Date.now()) + 1;
      let missing = 0;
      for (const item of schedule) {
        const brand = item.requiredBrand?.trim() ?? "";
        const person = item.instructor || item.teacher || "";
        const need = item.requiredQuantity ?? 1;
        for (let index = 0; index < need; index++) {
          const line: OrderLine = {
            id: id++, section: activeTab, date: selectedDate,
            scheduleRowId: item.id, brand, regNumber: "", usageGroup: "",
            purpose: item.title, route: trainingRoute(item.route || item.location || ""),
            driver: person, responsible: person,
            departureTime: item.startTime || "", returnTime: item.endTime || "", note: "",
          };
          const vehicle = brand && trainingVehicles.find(candidate =>
            candidate.brand.toLowerCase().includes(brand.toLowerCase()) &&
            !reserved.some(row => row.regNumber === candidate.plate && overlaps(row, line)),
          );
          if (vehicle) {
            line.brand = vehicle.brand;
            line.regNumber = vehicle.plate;
            line.usageGroup = vehicle.group ?? "";
          } else {
            missing++;
          }
          picked.push(line);
          if (vehicle) reserved.push(line);
        }
      }
      if (!picked.length) {
        toast.info("На выбранную дату в расписании нет заявок на машины");
        return;
      }
      await saveMutation.mutateAsync([
        ...latest.filter(row => row.section !== activeTab || row.date !== selectedDate),
        ...picked,
      ]);
      setSelectedRows(new Set());
      if (missing) toast.info(`Без машины: ${missing}. Выберите подходящие машины в таблице.`);
    } catch {
      toast.error("Не удалось заполнить строки по расписанию");
    } finally {
      setPicking(false);
    }
  };

  const changeTrainingVehicle = (line: OrderLine, plate: string) => {
    const vehicle = trainingVehicles.find(candidate => candidate.plate === plate);
    if (vehicle && lines.some(row => row.id !== line.id && row.date === selectedDate &&
        row.regNumber === plate && overlaps(row, line))) {
      toast.error("Машина уже назначена на это время");
      return;
    }
    saveMutation.mutate(lines.map(row => row.id === line.id ? {
      ...row,
      brand: vehicle?.brand ?? row.brand,
      regNumber: vehicle?.plate ?? "",
      usageGroup: vehicle?.group ?? "",
    } : row));
  };

  const transferTraining = async () => {
    const chosen = filteredLines.filter(row => selectedRows.has(row.id));
    if (busy || !chosen.length) return;
    if (chosen.some(row => !trainingVehicles.some(vehicle => vehicle.plate === row.regNumber))) {
      toast.error("Выберите допустимую машину в каждой отмеченной строке");
      return;
    }
    if (chosen.some(row => lines.some(other => other.id !== row.id && other.date === selectedDate &&
      other.regNumber === row.regNumber && overlaps(row, other)))) {
      toast.error("В выбранных строках есть машины, назначенные на пересекающееся время");
      return;
    }
    setTransferring(true);
    try {
      const drafts = await apiGetCollection<TrainingDraft>("order-drafts");
      const draft = drafts.find(item => item.date === selectedDate);
      const incoming = new Set(chosen.map(row => row.id));
      const existing = (draft?.lines ?? []).filter(row => !incoming.has(row.id) &&
        !chosen.some(line => row.section === line.section && row.scheduleRowId === line.scheduleRowId &&
          row.scheduleRowId != null && row.regNumber === line.regNumber));
      if (chosen.some(row => existing.some(other =>
        other.regNumber === row.regNumber && overlaps(row, other)))) {
        toast.error("В черновике уже назначена та же машина на это время");
        return;
      }
      const updated = {
        id: draft?.id ?? drafts.reduce((max, item) => Math.max(max, item.id), Date.now()) + 1,
        date: selectedDate,
        lines: [...existing, ...chosen],
      };
      await apiPutCollection("order-drafts", draft
        ? drafts.map(item => item.id === draft.id ? updated : item)
        : [...drafts, updated]);
      await queryClient.invalidateQueries({ queryKey: ["order-drafts"] });
      toast.success("Строки перенесены в черновик наряда");
    } catch {
      toast.error("Не удалось перенести строки в наряд");
    } finally {
      setTransferring(false);
    }
  };

  const handleOtherAutopick = async () => {
    const collection = SCHEDULE_COLLECTION[activeTab];
    if (!collection) {
      toast.info("Для этого раздела нет источника расписания");
      return;
    }
    try {
      const items = await apiGetCollection<ScheduleItem>(collection);
      const isBmp4xx = (plate: string) => /^4\d{2}/.test(plate.replace(/\s/g, ""));
      const isSsh = (v: { group?: string }) => /СШ|сверхштат/i.test(v.group ?? "");
      const matched = vehicles.filter((v) => !isBmp4xx(v.plate) || isSsh(v));
      const newLines: OrderLine[] = [];
      let idBase = Date.now();
      for (const item of items) {
        const need = item.requiredQuantity || 1;
        const pool = matched.filter((v) => !item.requiredBrand || v.brand.toLowerCase().includes(item.requiredBrand.toLowerCase()));
        const picked = pool.slice(0, need);
        const rows = picked.length ? picked : [null];
        for (const v of rows) {
          newLines.push({
            id: idBase++,
            section: activeTab,
            brand: v?.brand ?? item.requiredBrand,
            regNumber: v?.plate ?? "",
            usageGroup: v?.group ?? "",
            driver: item.instructor || item.teacher || "",
            route: item.route || item.location || "",
            purpose: item.title,
            departureTime: item.startTime || "",
            returnTime: item.endTime || "",
            responsible: "",
            note: item.location || "",
            date: item.date || selectedDate,
          });
        }
      }
      if (!newLines.length) {
        toast.info("В расписании нет записей для подбора");
        return;
      }
      saveMutation.mutate([...lines, ...newLines]);
      toast.success(`Добавлено строк: ${newLines.length}`);
    } catch {
      toast.error("Не удалось загрузить расписание");
    }
  };

  const handleExcelImport = async (file: File) => {
    try {
      const rows = await readExcelRows(file);
      const toTime = (s: string) => {
        const m = s.trim().match(/(\d{1,2})[:.](\d{2})/);
        return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
      };
      const imported: OrderLine[] = rows
        .map((row, i) => {
          const brand = pickString(row, "Марка", "Марка машины", "Техника", "Наименование");
          const purpose = pickString(row, "Назначение", "Цель", "Название", "Наименование мероприятия");
          if (!brand && !purpose) return null;
          return {
            id: Date.now() + i,
            section: activeTab,
            brand,
            regNumber: pickString(row, "Гос. номер", "Госномер", "Номер"),
            usageGroup: pickString(row, "Группа", "Группа эксплуатации"),
            driver: pickString(row, "Водитель", "Ответственный", "Преподаватель"),
            route: pickString(row, "Маршрут"),
            purpose,
            departureTime: toTime(pickString(row, "Время выезда", "Время начала", "Начало")),
            returnTime: toTime(pickString(row, "Время возвращения", "Время окончания", "Конец")),
            responsible: pickString(row, "Ответственный"),
            note: pickString(row, "Примечание", "Примечания"),
            date: pickString(row, "Дата") || selectedDate,
          };
        })
        .filter((x): x is OrderLine => x !== null);
      if (!imported.length) {
        toast.error("В файле не найдено строк");
        return;
      }
      saveMutation.mutate([...lines, ...imported]);
      toast.success(`Импортировано строк: ${imported.length}`);
    } catch {
      toast.error("Не удалось прочитать файл Excel");
    }
  };

  if (training) return (
    <div>
      <PageHeader title="Учебные средства"
        subtitle={`Строк в разделе: ${filteredLines.length}. Автоподбор по расписанию ОУП.`}
        actions={<>
          <label className="flex items-center gap-2 text-sm">
            Дата
            <Input type="date" className="w-[132px]" disabled={busy} value={selectedDate}
              onChange={event => { setSelectedRows(new Set()); setSelectedDate(event.target.value); }} />
          </label>
          <Button variant="outline" disabled={busy || !selectedDate} onClick={handleTrainingAutopick}>
            {picking ? "Заполнение…" : "Автозаполнение"}
          </Button>
          <Button disabled={busy || !selectedRows.size} onClick={transferTraining}>
            Перенести в «Наряд»
          </Button>
        </>}
      />
      <Panel className="overflow-x-auto rounded-lg border-[#e2e2e2]">
        <table className="w-full min-w-[1200px] table-fixed border-collapse text-[13px] leading-5">
          <colgroup>
            {[36, 249, 162, 144, 250, 169, 144, 144, 144, 140].map((width, index) => (
              <col key={index} style={{ width: `${width / 15.82}%` }} />
            ))}
          </colgroup>
          <thead className="bg-[#f7f7f7] text-[12px] leading-4 text-neutral-500">
            <tr>
              <th className="px-2 py-4 text-center align-middle">
                <input className="align-middle" type="checkbox" aria-label="Выбрать все"
                  checked={allSelected} disabled={!filteredLines.length || busy} onChange={toggleAllRows} />
              </th>
              {["Марка машины", "Государственный регистрационный знак", "Группа эксплуатации",
                "Для каких целей назначается машина", "Маршрут движения", "В чьё распоряжение",
                "Время выезда", "Время возвращения", "Примечание"].map(label => (
                <th key={label} scope="col" className="px-2 py-4 text-left align-middle font-normal">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredLines.map(line => (
              <tr key={line.id} className={cn("border-t border-[#f0f0f0]", selectedRows.has(line.id) && "bg-accent")}>
                <td className="px-2 py-3 text-center align-middle">
                  <input className="align-middle" type="checkbox" aria-label={`Выбрать строку ${line.id}`}
                    checked={selectedRows.has(line.id)} disabled={busy} onChange={() => toggleRowSelection(line.id)} />
                </td>
                <td className="px-2 py-3 align-middle">
                  <select aria-label="Марка машины" disabled={busy}
                    className="h-[38px] w-full rounded-md border border-input bg-background px-2 text-[13px]"
                    value={trainingVehicles.some(vehicle => vehicle.plate === line.regNumber) ? line.regNumber : ""}
                    onChange={event => changeTrainingVehicle(line, event.target.value)}>
                    <option value="">{line.brand ? `Подбор: ${line.brand}` : "Выберите машину"}</option>
                    {trainingVehicles.map(vehicle => (
                      <option key={vehicle.id} value={vehicle.plate}>
                        {vehicle.brand} · {vehicle.plate} · {vehicle.group}
                      </option>
                    ))}
                  </select>
                </td>
                {[line.regNumber, line.usageGroup, line.purpose, line.route,
                  line.responsible || line.driver, line.departureTime, line.returnTime, line.note || today].map((value, i) => (
                  <td key={i} className="whitespace-pre-wrap break-words px-2 py-3 align-middle">{value}</td>
                ))}
              </tr>
            ))}
            {!filteredLines.length && (
              <tr><td colSpan={10} className="py-12 text-center text-sm text-neutral-500">
                {isLoading ? "Загрузка…" : "На выбранную дату строк нет"}
              </td></tr>
            )}
          </tbody>
        </table>
      </Panel>
    </div>
  );

  return (
    <div>
      <PageHeader
        title={orderTabs.find(tab => tab.key === activeTab)?.label ?? "Наряд"}
        subtitle={`Строк в разделе: ${filteredLines.length}`}
        actions={
          <>
            <label className="flex items-center gap-2 text-sm">Дата<Input type="date" className="w-36" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} /></label>
            <Button variant="outline" onClick={handleOtherAutopick}>
              <FileText className="mr-2 h-4 w-4" />
              Подбор по расписанию
            </Button>
            <Button variant="outline" onClick={() => document.getElementById("excel-upload")?.click()}>
              <Download className="mr-2 h-4 w-4" />
              Импорт Excel
            </Button>
            <input
              id="excel-upload"
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleExcelImport(file);
                e.target.value = "";
              }}
            />
          </>
        }
      />

      <Panel className="thin-scroll max-h-[calc(100vh-12rem)] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-neutral-50 text-xs text-neutral-500 [&_th]:font-normal">
            <tr className="border-b border-border">
              <th className="w-12 px-3 py-3">
                <input
                  type="checkbox"
                  aria-label="Выбрать все"
                  checked={allSelected}
                  onChange={toggleAllRows}
                />
              </th>
              <th className="px-3 py-3 text-left">ТС</th>
              <th className="px-3 py-3 text-left">Гос. номер</th>
              <th className="px-3 py-3 text-left">Группа</th>
              <th className="px-3 py-3 text-left">Назначение</th>
              <th className="px-3 py-3 text-left">Маршрут</th>
              <th className="px-3 py-3 text-left">Ответственный</th>
              <th className="px-3 py-3 text-left">Время выезда</th>
              <th className="px-3 py-3 text-left">Время возвращения</th>
              <th className="px-3 py-3 text-left">Дата</th>
              <th className="px-3 py-3 text-left">Примечание</th>
            </tr>
          </thead>
          <tbody>
            {filteredLines.length === 0 ? (
              <tr>
                <td colSpan={10} className="py-20 text-center text-muted-foreground">
                  В этом разделе записей нет
                </td>
              </tr>
            ) : (
              filteredLines.map((line) => (
                <tr key={line.id} className={cn("border-b border-border", selectedRows.has(line.id) && "bg-accent")}>
                  <td className="px-3 py-3 text-center">
                    <input
                      type="checkbox"
                      checked={selectedRows.has(line.id)}
                      onChange={() => toggleRowSelection(line.id)}
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      value={line.brand}
                      onChange={(e) => handleCellEdit(line.id, "brand", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      value={line.regNumber}
                      onChange={(e) => handleCellEdit(line.id, "regNumber", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      value={line.usageGroup}
                      onChange={(e) => handleCellEdit(line.id, "usageGroup", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      value={line.purpose}
                      onChange={(e) => handleCellEdit(line.id, "purpose", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      value={line.route}
                      onChange={(e) => handleCellEdit(line.id, "route", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      value={line.responsible}
                      onChange={(e) => handleCellEdit(line.id, "responsible", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      type="time"
                      value={line.departureTime}
                      onChange={(e) => handleCellEdit(line.id, "departureTime", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      type="time"
                      value={line.returnTime}
                      onChange={(e) => handleCellEdit(line.id, "returnTime", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      type="date"
                      value={line.date || ""}
                      onChange={(e) => handleCellEdit(line.id, "date", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      value={line.note}
                      onChange={(e) => handleCellEdit(line.id, "note", e.target.value)}
                      className="h-8"
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>

      <Panel className="mt-4 flex gap-2 p-3">
        <Button variant="danger" onClick={handleDeleteSelected} disabled={selectedRows.size === 0}>
          <Trash2 className="mr-2 h-4 w-4" />
          Удалить выбранные ({selectedRows.size})
        </Button>
        <Button onClick={handleAddRow}>
          <Plus className="mr-2 h-4 w-4" />
          Добавить строку
        </Button>
        <Button variant="outline" disabled={true}>
          Сохранить изменения
        </Button>
      </Panel>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Подтверждение удаления"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Отмена
            </Button>
            <Button variant="danger" onClick={performDelete}>
              Удалить
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Вы уверены, что хотите удалить выбранные строки ({deleteTarget?.size ?? 0})? Это действие нельзя отменить.
        </p>
      </Modal>
    </div>
  );
}