import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Modal, PageHeader, Panel } from "@/components/ui-kit";
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

type OrderDraft = { id: number; date: string; lines: OrderLine[] };

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
  if (a.returnTime <= a.departureTime || b.returnTime <= b.departureTime) return true;
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
  const duty = activeTab === "duty";
  const [changes, setChanges] = useState<Record<number, Partial<OrderLine>>>({});
  const [importing, setImporting] = useState(false);
  const hasChanges = Object.keys(changes).length > 0;
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Set<number> | null>(null);

  const queryClient = useQueryClient();

  const { data: lines = [], isLoading } = useQuery({
    queryKey: ["order-section-lines"],
    queryFn: () => apiGetCollection<OrderLine>("order-section-lines"),
  });

  const displayedLines = lines.map(line => ({ ...line, ...changes[line.id] }));
  const filteredLines = displayedLines.filter(line => line.section === activeTab &&
    (line.date === selectedDate || (duty && !line.date)));

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

  const editLine = (id: number, fields: Partial<OrderLine>) => {
    setChanges(current => ({ ...current, [id]: { ...current[id], ...fields } }));
  };

  const saveChanges = async () => {
    if (busy || !hasChanges) return;
    try {
      await saveMutation.mutateAsync(displayedLines);
      setChanges({});
    } catch {
      // The mutation reports the error and the edits stay in the table.
    }
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

  const allowedVehicles = vehicles.filter(eligibleTrainingVehicle);
  const busy = isLoading || importing || picking || transferring || saveMutation.isPending;
  const today = selectedDate.split("-").reverse().join(".");

  const handleAutopick = async () => {
    const collection = SCHEDULE_COLLECTION[activeTab];
    if (busy || hasChanges || !selectedDate || !collection) return;
    setPicking(true);
    try {
      const items = await apiGetCollection<ScheduleItem>(collection);
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
          const vehicle = allowedVehicles.find(candidate =>
            (!brand || candidate.brand.toLowerCase().includes(brand.toLowerCase())) &&
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

  const changeVehicle = (line: OrderLine, plate: string) => {
    const vehicle = allowedVehicles.find(candidate => candidate.plate === plate);
    if (vehicle && displayedLines.some(row => row.id !== line.id && row.date === selectedDate &&
        row.regNumber === plate && overlaps(row, line))) {
      toast.error("Машина уже назначена на это время");
      return;
    }
    const fields = {
      brand: vehicle?.brand ?? (duty ? line.brand : ""),
      regNumber: vehicle?.plate ?? (duty ? line.regNumber : ""),
      usageGroup: vehicle?.group ?? (duty ? line.usageGroup : ""),
    };
    if (training) {
      saveMutation.mutate(lines.map(row => row.id === line.id ? { ...row, ...fields } : row));
    } else {
      editLine(line.id, fields);
    }
  };

  const transferRows = async () => {
    if (busy || hasChanges || !selectedDate) return;
    const chosen = filteredLines.filter(row => selectedRows.has(row.id))
      .map(row => ({ ...row, date: row.date || selectedDate }));
    if (!chosen.length) return;
    if (chosen.some(row => {
      const vehicle = vehicles.find(candidate => candidate.plate === row.regNumber);
      return vehicle ? !eligibleTrainingVehicle(vehicle) :
        !duty || !eligibleTrainingVehicle({ brand: row.brand, plate: row.regNumber, group: row.usageGroup }) ||
        !row.brand.trim();
    })) {
      toast.error("Укажите допустимую машину в каждой отмеченной строке");
      return;
    }
    if (chosen.some(row => lines.some(other => other.id !== row.id && other.date === selectedDate &&
      other.regNumber === row.regNumber && overlaps(row, other)))) {
      toast.error("В выбранных строках есть машины, назначенные на пересекающееся время");
      return;
    }
    setTransferring(true);
    try {
      const drafts = await apiGetCollection<OrderDraft>("order-drafts");
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

  const handleExcelImport = async (file: File) => {
    if (busy || hasChanges || !selectedDate) return;
    setImporting(true);
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
            regNumber: pickString(row, "Государственный регистрационный знак", "Гос. номер", "Госномер", "Номер"),
            usageGroup: pickString(row, "Группа", "Группа эксплуатации"),
            driver: pickString(row, "Водитель", "Ответственный", "Преподаватель"),
            route: trainingRoute(pickString(row, "Маршрут движения", "Маршрут")),
            purpose,
            departureTime: toTime(pickString(row, "Время выезда", "Время начала", "Начало")),
            returnTime: toTime(pickString(row, "Время возвращения", "Время окончания", "Конец")),
            responsible: pickString(row, "В чьё распоряжение", "В чье распоряжение", "Ответственный"),
            note: pickString(row, "Примечание", "Примечания"),
            date: (() => {
              const value = pickString(row, "Дата").trim();
              if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
              const local = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
              return local ? `${local[3]}-${local[2]}-${local[1]}` : selectedDate;
            })(),
          };
        })
        .filter((x): x is OrderLine => x !== null);
      if (!imported.length) {
        toast.error("В файле не найдено строк");
        return;
      }
      const key = (line: OrderLine) => JSON.stringify([
        line.section, line.date, line.regNumber.trim().toUpperCase().replace(/\s/g, ""),
        line.purpose.trim(), line.departureTime, line.returnTime,
        line.regNumber ? "" : line.brand.trim(),
      ]);
      const updated = [...lines];
      const index = new Map(lines.map((line, position) => [key(line), position] as const));
      let nextId = lines.reduce((max, line) => Math.max(max, line.id), Date.now()) + 1;
      for (const row of imported) {
        const signature = key(row);
        const position = index.get(signature);
        if (position === undefined) {
          index.set(signature, updated.length);
          updated.push({ ...row, id: nextId++ });
        } else {
          updated[position] = { ...updated[position], ...row, id: updated[position].id };
        }
      }
      await saveMutation.mutateAsync(updated);
    } catch {
      toast.error("Не удалось импортировать Excel");
    } finally {
      setImporting(false);
    }
  };

  const heading = orderTabs.find(tab => tab.key === activeTab)?.label ?? "Наряд";
  const fields = ["regNumber", "usageGroup", "purpose", "route", "responsible",
    "departureTime", "returnTime", duty ? "date" : "note"] as const;
  const headings = duty
    ? ["ТС", "Гос. номер", "Группа", "Назначение", "Маршрут", "Ответственный",
        "Время выезда", "Время возвращения", "Дата"]
    : ["Марка машины", "Государственный регистрационный знак", "Группа эксплуатации",
        "Для каких целей назначается машина", "Маршрут движения", "В чьё распоряжение",
        "Время выезда", "Время возвращения", "Примечание"];
  const widths = training ? [36, 249, 162, 144, 250, 169, 144, 144, 144, 140]
    : duty ? [36, 320, 148, 148, 148, 148, 148, 135, 135, 135]
      : [36, 235, 159, 142, 186, 160, 160, 143, 143, 135];

  return (
    <div>
      <PageHeader title={heading}
        subtitle={`Строк в разделе: ${filteredLines.length}${training ? ". Автоподбор по расписанию ОУП." : ""}`}
        actions={<>
          <label className="flex items-center gap-2 text-sm">
            Дата
            <Input type="date" className="w-[132px]" disabled={busy || hasChanges} value={selectedDate}
              onChange={event => { setSelectedRows(new Set()); setSelectedDate(event.target.value); }} />
          </label>
          {!duty && <Button variant="outline" disabled={busy || hasChanges || !selectedDate} onClick={handleAutopick}>
            {picking ? "Заполнение…" : activeTab === "household" ? "Подбор по расписанию" : "Автозаполнение"}
          </Button>}
          {!training && <>
            <Button variant="outline" disabled={busy || hasChanges || !selectedDate}
              onClick={() => document.getElementById("order-excel-upload")?.click()}>
              {importing ? "Импорт…" : "Импорт Excel"}
            </Button>
            <input id="order-excel-upload" type="file" accept=".xlsx,.xls" className="hidden"
              onChange={event => {
                const file = event.target.files?.[0];
                if (file) void handleExcelImport(file);
                event.target.value = "";
              }} />
          </>}
          <Button disabled={busy || hasChanges || !selectedDate || !selectedRows.size} onClick={transferRows}>
            Перенести в «Наряд»
          </Button>
        </>}
      />
      <Panel className="overflow-x-auto rounded-lg border-[#e2e2e2]">
        <table className="w-full min-w-[1200px] table-fixed border-collapse text-[13px] leading-5">
          <colgroup>
            {widths.map((width, index) => (
              <col key={index} style={{ width: `${100 * width / widths.reduce((sum, value) => sum + value, 0)}%` }} />
            ))}
          </colgroup>
          <thead className="bg-[#f7f7f7] text-[12px] leading-4 text-neutral-500">
            <tr>
              <th className="px-2 py-4 text-center align-middle">
                <input className="align-middle" type="checkbox" aria-label="Выбрать все"
                  checked={allSelected} disabled={!filteredLines.length || busy} onChange={toggleAllRows} />
              </th>
              {headings.map(label => (
                <th key={label} scope="col" className="px-2 py-4 text-left align-middle font-normal">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredLines.map(line => {
              const inFleet = allowedVehicles.some(vehicle => vehicle.plate === line.regNumber);
              const cell = cn("px-2 align-middle", training ? "py-3" : "py-1");
              return (
                <tr key={line.id} className={cn("border-t border-[#f0f0f0]", selectedRows.has(line.id) && "bg-accent")}>
                  <td className={cn(cell, "text-center")}>
                    <input className="align-middle" type="checkbox" aria-label={`Выбрать строку ${line.id}`}
                      checked={selectedRows.has(line.id)} disabled={busy} onChange={() => toggleRowSelection(line.id)} />
                  </td>
                  <td className={cell}>
                    <select aria-label="Марка машины" disabled={busy}
                      className="h-[38px] w-full rounded-md border border-input bg-background px-2 text-[13px]"
                      value={inFleet ? line.regNumber : ""}
                      onChange={event => changeVehicle(line, event.target.value)}>
                      <option value="">{duty ? "Своя марка / вне списка" : line.brand ? `Подбор: ${line.brand}` : "Выберите машину"}</option>
                      {allowedVehicles.map(vehicle => (
                        <option key={vehicle.id} value={vehicle.plate}>
                          {vehicle.brand} · {vehicle.plate} · {vehicle.group}
                        </option>
                      ))}
                    </select>
                    {duty && !inFleet && <Input className="mt-1 h-[38px]" aria-label="Своя марка"
                      disabled={busy} value={line.brand} onChange={event => editLine(line.id, { brand: event.target.value })} />}
                  </td>
                  {fields.map((field, index) => {
                    const value = field === "responsible" ? line.responsible || line.driver
                      : field === "note" && training ? line.note || today
                        : line[field] ?? "";
                    const time = field === "departureTime" || field === "returnTime";
                    const editable = !training && field !== "date" &&
                      ((field !== "regNumber" && field !== "usageGroup") || (duty && !inFleet));
                    return (
                      <td key={field} className={cn(cell, "whitespace-pre-wrap break-words")}>
                        {editable ? <Input aria-label={headings[index + 1]} type={time ? "time" : "text"}
                          className="h-9 border-transparent bg-transparent px-1 shadow-none hover:border-input focus:border-input"
                          disabled={busy} value={value} onChange={event => editLine(line.id, field === "responsible"
                            ? { responsible: event.target.value, driver: event.target.value }
                            : { [field]: event.target.value })} />
                          : field === "date" ? (value || selectedDate).split("-").reverse().join(".") : value}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {!filteredLines.length && (
              <tr><td colSpan={10} className="py-12 text-center text-sm text-neutral-500">
                {isLoading ? "Загрузка…" : "На выбранную дату строк нет"}
              </td></tr>
            )}
          </tbody>
        </table>
      </Panel>

      {!training && <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="danger" disabled={busy || hasChanges || !selectedRows.size} onClick={handleDeleteSelected}>
          Удалить выбранные ({selectedRows.size})
        </Button>
        <Button variant="outline" disabled={busy || hasChanges || !selectedDate} onClick={handleAddRow}>
          Добавить строку
        </Button>
        <Button disabled={busy || !hasChanges} onClick={saveChanges}>Сохранить изменения</Button>
        {hasChanges && <Button variant="outline" disabled={busy} onClick={() => setChanges({})}>Отмена</Button>}
      </div>}

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