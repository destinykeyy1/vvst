import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PasswordGate } from "@/components/PasswordGate";
import { Button, Field, Input, Modal, PageHeader, Panel, Select } from "@/components/ui-kit";
import { TYPE_LABELS, VehicleFormModal } from "@/components/VehicleForm";
import {
  PASSPORT_HEADERS,
  exportPassportExcel,
  importPassportExcel,
  applyPassportCellEdit,
  vehicleToPassportRow,
} from "@/lib/passportExcel";
import { formatNumber } from "@/lib/logic";
import { getState, nextVehicleId, setState, updateVehicles, useAppState } from "@/lib/store";
import type { Vehicle, VehicleType } from "@/lib/types";
import { cn } from "@/lib/utils";

const columnWidths = [76, 160, 160, 96, 208, 240, 240, 240];
const selectionWidth = 48;
const pinnedColumns = 5;
const columnWidth = (index: number) => columnWidths[index] ?? 160;


export const Route = createFileRoute("/vvst")({
  head: () => ({
    meta: [
      { title: "Перечень ВВСТ — Планирование ВВСТ" },
      { name: "description", content: "Полный перечень машин ВВСТ с поиском, фильтрами и редактированием." },
      { property: "og:title", content: "Перечень ВВСТ — Планирование ВВСТ" },
      { property: "og:description", content: "Полный перечень машин ВВСТ с поиском, фильтрами и редактированием." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PasswordGate section="vvst" title="Перечень ВВСТ">
      <VvstPage />
    </PasswordGate>
  ),
});

type EditableKey = "unit" | "brand" | "year" | "commissionDate" | "order" | "plate" | "group" | "assignedTo" | "mileage" | "motoHours" | "statusReason";

interface Column {
  key: EditableKey;
  label: string;
  numeric?: boolean;
}

const COLUMNS: Column[] = [
  { key: "unit", label: "Подразделение" },
  { key: "brand", label: "Марка машины" },
  { key: "year", label: "Год выпуска", numeric: true },
  { key: "commissionDate", label: "Дата ввода в эксплуатацию" },
  { key: "order", label: "Наряд на получение (передачу) ВВСТ" },
  { key: "plate", label: "Государственный регистрационный знак (строевой номер)" },
  { key: "group", label: "Группа эксплуатации" },
  { key: "assignedTo", label: "Закреплённый водитель" },
  { key: "mileage", label: "Пробег, км", numeric: true },
  { key: "motoHours", label: "Моточасы", numeric: true },
];

// Passport column index (0-based) -> editable Vehicle field.
const EDITABLE_BY_COL: Partial<Record<number, EditableKey>> = {
  1: "unit",
  2: "brand",
  3: "year",
  4: "commissionDate",
  5: "order",
  6: "plate",
  7: "group",
  8: "assignedTo",
  12: "statusReason",
  95: "mileage",
  102: "motoHours",
};

const NUMERIC_COLS = new Set([3, 95, 102]);

interface Edit {
  id: number;
  key: EditableKey | number;
  value: string | number;
}

function applyEdit(vehicle: Vehicle, { key, value }: Edit): Vehicle {
  if (typeof key === "number") return applyPassportCellEdit(vehicle, key, String(value));
  if (key === "motoHours") {
    const updated = applyVehicleEdit(vehicle, { key, value, id: vehicle.id });
    return applyPassportCellEdit(updated, MOTO_HOURS_COLUMN, value);
  }
  return { ...vehicle, [key]: value };
}

const ALL_COLUMNS = PASSPORT_HEADERS.map((_, index) => index);
const MOTO_HOURS_COLUMN = 102;
const PASSPORT_HOURS_HEADER = "текущие показания моточасов";
const numberSort = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

const WRITE_OFF_FILTERS = [
  { label: "АКБ", columns: [55, 56, 63, 64], readings: [55, 63], age: 60 },
  { label: "Шины", columns: [71, 72, 79, 80], readings: [71, 79], age: null },
  { label: "ТШ-З", columns: [87, 88, 89], readings: [88], age: 72 },
  { label: "ТШ-Л", columns: [90, 91, 92], readings: [91], age: 60 },
  { label: "Тенты", columns: [81, 82, 83], readings: [82], age: 72 },
  { label: "Брезенты", columns: [84, 85, 86], readings: [85], age: 60 },
];

function toNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const number = Number(value.trim().replace(/[\s\u00a0]/g, "").replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function overdue(value: unknown, age: number | null) {
  if (age === null) {
    const reading = toNumber(value);
    return reading !== null && reading < 0;
  }
  if (typeof value !== "string") return false;
  const years = value.match(/(\d+)\s*(?:лет|год(?:а)?)/i);
  const months = value.match(/(\d+)\s*мес/i);
  return Boolean(years || months) &&
    Number(years?.[1] ?? 0) * 12 + Number(months?.[1] ?? 0) >= age;
}

function passportHours(vehicle: Vehicle) {
  const field = vehicle.rawDto?.passportData?.find(({ header }) =>
    header.trim().replace(/\s+/g, " ").toLowerCase() === PASSPORT_HOURS_HEADER,
  );
  return field ? toNumber(field.value) : vehicle.motoHours;
}

function applyVehicleEdit(vehicle: Vehicle, edit: Edit): Vehicle {
  if (edit.key !== "motoHours" || typeof edit.value !== "number" || !vehicle.rawDto) {
    return { ...vehicle, [edit.key]: edit.value };
  }

  const value = edit.value;
  const fields = vehicle.rawDto.passportData ?? [];
  const isHours = (field: (typeof fields)[number]) => {
    const header = field.header.toLowerCase().replace(/[^а-яё0-9]/g, "");
    return !/\d|сначала|норм/.test(header) && header.includes("моточас") &&
      (header.includes("текущ") || ("ordinal" in field && field.ordinal === 103));
  };
  const header = "Текущие показания МОТОЧАСОВ";
  const passportData = fields.some(isHours)
    ? fields.map(field => isHours(field) ? { ...field, header, value } : field)
    : [...fields, { header, value, column: fields.reduce((max, field) => Math.max(max, field.column), 0) + 1 }];
  return { ...vehicle, motoHours: edit.value, rawDto: { ...vehicle.rawDto, passportData } };
}

const PLATE_LETTERS: Record<string, string> = {
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H",
  О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X",
};

function plateKey(value: string | null | undefined) {
  return (value ?? "").normalize("NFKC").toUpperCase().replace(/[\s‐‑–—-]/g, "")
    .replace(/[АВЕКМНОРСТУХ]/g, (letter) => PLATE_LETTERS[letter]);
}

function compareCells(a: unknown, b: unknown, ascending: boolean) {
  const emptyA = a == null || a === "";
  const emptyB = b == null || b === "";
  if (emptyA || emptyB) return Number(emptyA) - Number(emptyB);
  const aNumber = toNumber(a);
  const bNumber = toNumber(b);
  const dateKey = (value: unknown) =>
    String(value).replace(/^(\d{2})\.(\d{2})\.(\d{4})$/, "$3-$2-$1");
  const order = aNumber !== null && bNumber !== null
    ? aNumber - bNumber
    : numberSort.compare(dateKey(a), dateKey(b));
  return ascending ? order : -order;
}

function VvstPage() {
  const vehicles = useAppState((s) => s.vehicles);
  const toInterval = useAppState((s) => s.settings.toIntervalKm);

  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | VehicleType>("all");
  const [woFilter, setWoFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [edits, setEdits] = useState<Edit[]>([]);
  const [redo, setRedo] = useState<Edit[]>([]);
  const [editing, setEditing] = useState<{ id: number; key: EditableKey | number; draft: string } | null>(null);
  const [sort, setSort] = useState<{ col: number; ascending: boolean } | null>(null);
  const [visible, setVisible] = useState(() => new Set(ALL_COLUMNS));
  const [columnDraft, setColumnDraft] = useState<Set<number> | null>(null);
  const [importing, setImporting] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [toOpen, setToOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Set<number> | null>(null);

  const withEdits = useMemo(() => {
    const map = new Map<number, Vehicle>();
    vehicles.forEach((v) => {
      const hours = passportHours(v);
      map.set(v.id, hours == null ? v : { ...v, motoHours: hours });
    });
    for (const e of edits) {
      const v = map.get(e.id);
      if (v) map.set(e.id, applyEdit(v, e));
    }
    return vehicles.map((v) => map.get(v.id) ?? v);
  }, [vehicles, edits]);

  const editedCells = useMemo(() => new Set(edits.map((e) => `${e.id}:${e.key}`)), [edits]);

  const filter = WRITE_OFF_FILTERS.find((item) => item.label === woFilter);
  const visibleColumns = filter
    ? [...new Set([0, 1, 2, 3, 4, ...filter.columns])]
    : ALL_COLUMNS.filter((column) => visible.has(column));

  const pinnedOffsets = new Map<number, number>();
  const tableWidth = visibleColumns.reduce((left, column) => {
    if (column < pinnedColumns) pinnedOffsets.set(column, left);
    return left + columnWidth(column);
  }, selectionWidth);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = withEdits.map((v, i) => {
      const cells = vehicleToPassportRow(v, toInterval, i);
      cells[MOTO_HOURS_COLUMN] = editedCells.has(`${v.id}:motoHours`)
        ? v.motoHours
        : passportHours(v) ?? "";
      const flagged = filter
        ? filter.readings.filter((column) => overdue(cells[column], filter.age))
        : [];
      return { v, cells, flagged };
    }).filter(({ v, flagged }) =>
      (type === "all" || v.type === type) &&
      (!q || v.brand.toLowerCase().includes(q) || v.plate.toLowerCase().includes(q)) &&
      (!filter || flagged.length > 0),
    );
    return sort && (filter ? sort.col < 5 || filter.columns.includes(sort.col) : visible.has(sort.col))
      ? rows.sort((a, b) => compareCells(a.cells[sort.col], b.cells[sort.col], sort.ascending))
      : rows;
  }, [withEdits, query, type, filter, toInterval, editedCells, sort, visible]);

  const pushEdit = (e: Edit) => {
    setEdits((prev) => [...prev, e]);
    setRedo([]);
  };

  const save = () => {
    updateVehicles((list) => list.map((vehicle) =>
      edits.reduce((updated, edit) => edit.id === vehicle.id
        ? applyEdit(updated, edit)
        : updated, vehicle),
    ));
    toast.success(`Сохранено изменений: ${edits.length}`);
    setEdits([]);
    setRedo([]);
  };

  const allSelected = rows.length > 0 && rows.every(({ v }) => selected.has(v.id));

  const importExcel = async () => {
    if (!importFile || importing) return;
    setImporting(true);
    try {
      const added = await importPassportExcel(importFile, nextVehicleId());
      const incoming = new Map<string, Vehicle>();
      let skipped = 0;
      for (const vehicle of added) {
        const key = plateKey(vehicle.plate);
        if (key) incoming.set(key, vehicle);
        else skipped++;
      }
      if (!incoming.size) {
        toast.error("В файле нет машин с регистрационным номером");
        return;
      }
      updateVehicles((list) => {
        const matched = new Set<string>();
        const updated = list.map((vehicle) => {
          const key = plateKey(vehicle.plate);
          const imported = incoming.get(key);
          if (!imported || matched.has(key)) return vehicle;
          matched.add(key);
          return { ...vehicle, ...imported, id: vehicle.id };
        });
        const usedIds = new Set(list.map(({ id }) => id));
        let nextId = nextVehicleId();
        for (const [key, vehicle] of incoming) {
          if (matched.has(key)) continue;
          while (usedIds.has(nextId)) nextId++;
          updated.push({ ...vehicle, id: nextId });
          usedIds.add(nextId++);
        }
        return updated;
      });
      toast.success(`Обработано машин: ${incoming.size}`);
      if (skipped) toast.error(`Пропущено строк без регистрационного номера: ${skipped}`);
      setImportOpen(false);
      setImportFile(null);
    } catch {
      toast.error("Не удалось импортировать файл Excel");
    } finally {
      setImporting(false);
    }
  };

  const commitCell = () => {
    if (!editing) return;
    const numeric = COLUMNS.find((column) => column.key === editing.key)?.numeric;
    const value = numeric ? (editing.draft.trim() ? toNumber(editing.draft) : null) : editing.draft;
    if (value === null || (typeof value === "number" && (value < 0 || (editing.key !== "motoHours" && !Number.isSafeInteger(value))))) {
      toast.error("Введите корректное число");
      return;
    }
    pushEdit({ id: editing.id, key: editing.key, value });
    setEditing(null);
  };

  const exportVvst = () => {
    const list = selected.size ? withEdits.filter((v) => selected.has(v.id)) : withEdits;
    void exportPassportExcel("Электронный_паспорт_ВВСТ.xlsx", list, toInterval).then(
      () => toast.success(`Экспортировано машин: ${list.length}`),
      () => toast.error("Не удалось экспортировать файл"),
    );
  };

  const exportAct = async () => {
    if (selected.size !== 1) return;
    const [vehicleId] = selected;
    const vehicle = vehicles.find(({ id }) => id === vehicleId);
    if (!vehicle) {
      toast.error("Машина не найдена в перечне ВВСТ");
      return;
    }
    try {
      const response = await fetch("/api/documents/condition/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Omsk" }),
          rows: [{ vehicleId }],
        }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error ?? "Не удалось сформировать акт");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      const name = [vehicle.brand, vehicle.plate].map((part) =>
        part.trim().replace(/[<>:"/\\|?*]/g, "-").replace(/ +/g, "_"),
      ).filter(Boolean).join("_");
      link.download = `Акт_технического_состояния_${name || vehicleId}.docx`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сформировать акт");
    }
  };

  return (
    <div>
      <PageHeader title="Перечень ВВСТ" subtitle={`Показано ${rows.length} из ${vehicles.length} машин`} />

      <Panel className="no-print mb-4 flex flex-wrap gap-2 p-3">
        <Input className="w-80" placeholder="Поиск по марке или гос. номеру..." value={query} onChange={(e) => setQuery(e.target.value)} />
        <Select value={type} onChange={(e) => setType(e.target.value as "all" | VehicleType)}>
          <option value="all">Все типы</option>
          {Object.entries(TYPE_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </Select>
        <Button variant="outline" onClick={() => setToOpen(true)}>
          Настроить ТО
        </Button>
        <Button variant="outline" onClick={() => setColumnDraft(new Set(visible))}>
          Столбцы
        </Button>
        {WRITE_OFF_FILTERS.map((f) => (
          <Button
            key={f.label}
            variant={woFilter === f.label ? "default" : "outline"}
            onClick={() => setWoFilter((cur) => (cur === f.label ? null : f.label))}
          >
            {woFilter === f.label ? "Снять фильтр" : "Фильтр"}: {f.label}
          </Button>
        ))}
        <Button variant="outline" onClick={() => setSelected(allSelected ? new Set() : new Set(rows.map(({ v }) => v.id)))}>
          {allSelected ? "Снять выбор" : "Выбрать все машины"}
        </Button>
        <Button
          variant="danger"
          disabled={selected.size === 0}
          onClick={() => {
            setDeleteTarget(selected);
            setDeleteOpen(true);
          }}
        >
          Удалить выбранные
        </Button>
        <Button variant="outline" onClick={exportVvst}>
          Экспорт Excel
        </Button>
        <Button onClick={() => setImportOpen(true)}>Импорт Excel</Button>
      </Panel>

      <Panel className="thin-scroll max-h-[calc(100vh-20rem)] overflow-auto">
        <table className="table-fixed border-collapse text-sm" style={{ width: tableWidth }}>
          <colgroup>
            <col style={{ width: selectionWidth }} />
            {visibleColumns.map(column => <col key={column} style={{ width: columnWidth(column) }} />)}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-muted">
            <tr className="border-b border-border">
              <th className="sticky left-0 z-10 bg-muted px-3 py-2 text-center align-middle">
                <input
                  className="mx-auto block size-4"
                  type="checkbox"
                  aria-label="Выбрать все"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map(({ v }) => v.id)))}
                />
              </th>
              {visibleColumns.map((i) => (
                <th key={i} aria-sort={sort?.col === i ? (sort.ascending ? "ascending" : "descending") : "none"} scope="col" style={{ left: pinnedOffsets.get(i) }} className={cn("px-2 py-3 align-middle text-xs font-normal tracking-wide text-neutral-500", i < 5 ? "sticky z-10 bg-muted text-left" : "text-center")}>
                  <span className="block text-[10px] text-muted-foreground">№ {i + 1}</span>
                  <button type="button" className="inline-flex items-center gap-1"
                    onClick={() => setSort(previous => ({ col: i, ascending: previous?.col === i ? !previous.ascending : true }))}>
                    {PASSPORT_HEADERS[i]} <span aria-hidden="true">{sort?.col === i ? (sort.ascending ? "↑" : "↓") : "↕"}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ v, cells, flagged }) => (
              <tr key={v.id} className={cn("border-b border-neutral-100", selected.has(v.id) ? "bg-accent" : "bg-card even:bg-neutral-50")}>
                <td className="sticky left-0 z-[1] bg-inherit px-3 py-2 text-center align-middle">
                  <input
                    className="mx-auto block size-4"
                    type="checkbox"
                    aria-label={`Выбрать ${v.brand}`}
                    checked={selected.has(v.id)}
                    onChange={() =>
                      setSelected((s) => {
                        const next = new Set(s);
                        if (next.has(v.id)) next.delete(v.id);
                        else next.add(v.id);
                        return next;
                      })
                    }
                  />
                </td>
                {visibleColumns.map((col) => {
                  const raw = cells[col];
                  const editKey = col === 0 ? undefined : EDITABLE_BY_COL[col] ?? col;
                  const isEditing = editKey !== undefined && editing?.id === v.id && editing.key === editKey;
                  const display = raw === "" || raw === null || raw === undefined ? "" : NUMERIC_COLS.has(col) ? formatNumber(Number(raw)) : String(raw);
                  const numeric = editKey ? COLUMNS.find((c) => c.key === editKey)?.numeric : false;
                  const highlighted = flagged.includes(col) || (flagged.includes(col - 1) && raw != null && raw !== "");
                  const edited = editKey !== undefined && editedCells.has(`${v.id}:${editKey}`);
                  return (
                    <td
                      key={col}
                      style={{ left: pinnedOffsets.get(col) }}
                      className={cn("px-2 py-2 align-middle text-sm", col < pinnedColumns ? "sticky z-[1]" : "text-center",
                        highlighted ? "border border-red-300 bg-red-100 text-red-900" :
                          edited ? "bg-warning-soft" : col < pinnedColumns && "bg-inherit")}
                    >
                      {isEditing ? (
                        <div className="space-y-1">
                          <Input autoFocus value={editing.draft} type={numeric ? "number" : "text"}
                            step={editKey === "motoHours" ? "any" : undefined}
                            className="h-7 w-full text-xs"
                            onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { e.preventDefault(); commitCell(); }
                              if (e.key === "Escape") setEditing(null);
                            }}
                          />
                          <div className="flex gap-2 text-xs">
                            <button type="button" className="text-green-800" onClick={commitCell}>Сохранить</button>
                            <button type="button" className="text-neutral-600" onClick={() => setEditing(null)}>Отмена</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between gap-1">
                          <span className="flex-1 whitespace-pre-wrap break-words">{display}</span>
                          {editKey !== undefined && (
                            <button
                              type="button"
                              aria-label={`Изменить: ${PASSPORT_HEADERS[col]}`}
                              className="no-print shrink-0 text-[10px] text-subtle hover:text-foreground"
                              onClick={() => setEditing({ id: v.id, key: editKey, draft: String(raw ?? "") })}
                            >
                              Изм.
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={visibleColumns.length + 1} className="py-10 text-center text-muted-foreground">
                  Машины не найдены
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      <div className="no-print mt-4 flex flex-wrap gap-2">
        <Button onClick={() => setAddOpen(true)}>Добавить машину</Button>
        <Button
          variant="outline"
          disabled={edits.length === 0}
          onClick={() => {
            const last = edits[edits.length - 1];
            if (!last) return;
            setEdits(edits.slice(0, -1));
            setRedo([...redo, last]);
          }}
        >
          Отменить
        </Button>
        <Button
          variant="outline"
          disabled={redo.length === 0}
          onClick={() => {
            const last = redo[redo.length - 1];
            if (!last) return;
            setRedo(redo.slice(0, -1));
            setEdits([...edits, last]);
          }}
        >
          Вернуть
        </Button>
        <Button variant={edits.length ? "default" : "outline"} disabled={edits.length === 0} onClick={save}>
          Сохранить изменения{edits.length ? ` (${edits.length})` : ""}
        </Button>
        <Button variant="outline" disabled={selected.size === 0} onClick={() => setGroupOpen(true)}>
          Групповое редактирование
        </Button>
        <Button
          variant="outline"
          disabled={selected.size === 0}
          onClick={() => {
            selected.forEach((id) => pushEdit({ id, key: "group", value: "ПС" }));
            toast("Группа «ПС» назначена выбранным машинам. Сохраните изменения.");
          }}
        >
          В постоянные средства
        </Button>
        <Button variant="outline" disabled={selected.size !== 1} onClick={exportAct}>
          Акт тех. состояния
        </Button>
      </div>

      <VehicleFormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSave={(d) => {
          updateVehicles((list) => [...list, { ...d, id: nextVehicleId(), status: "ready", statusReason: "", details: {} }]);
          setAddOpen(false);
          toast.success("Машина добавлена");
        }}
      />

      <Modal open={columnDraft !== null} onClose={() => setColumnDraft(null)}
        title="Видимость столбцов" size="md"
        footer={<>
          <Button variant="outline" onClick={() => setColumnDraft(null)}>Отмена</Button>
          <Button onClick={() => {
            if (columnDraft) { setVisible(columnDraft); setWoFilter(null); }
            setColumnDraft(null);
          }}>Применить</Button>
        </>}
      >
        <div className="mb-3 flex gap-3 text-xs">
          <button type="button" className="underline" onClick={() => setColumnDraft(new Set(ALL_COLUMNS))}>Выбрать все</button>
          <button type="button" className="underline" onClick={() => setColumnDraft(new Set())}>Снять все</button>
        </div>
        <div className="max-h-[65vh] overflow-auto">
          {ALL_COLUMNS.map((column) => (
            <label key={column} className="flex items-center gap-3 px-2 py-2 text-sm">
              <input type="checkbox" className="size-4 shrink-0" checked={columnDraft?.has(column) ?? false}
                onChange={() => setColumnDraft((previous) => {
                  if (!previous) return previous;
                  const next = new Set(previous);
                  if (next.has(column)) next.delete(column); else next.add(column);
                  return next;
                })}
              />
              {column + 1}. {PASSPORT_HEADERS[column]}
            </label>
          ))}
        </div>
      </Modal>

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="Импорт из Excel"
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              Отмена
            </Button>
            <Button onClick={importExcel} disabled={!importFile || importing}>
              {importing ? "Импорт…" : "Импортировать"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700">
            <p className="mb-2 text-xs uppercase tracking-wider text-neutral-500">Формат файла</p>
            <p className="mb-2">
              Поддерживаются шаблон паспорта АБТС и электронный паспорт (формуляр). Поля транспортного средства сохраняются в таблице, а распознанные поля (год выпуска, VIN, номера кузова, шасси и двигателя) также заносятся в СРТС.
            </p>
            <p>
              Сроки действия выделяются красным. (Срок службы аккумуляторной батареи выделяется по достижении 5 лет, а износ шин — при отрицательном остатке ресурса. Для быстрого просмотра используйте фильтры «Фильтр: АКБ» и «Фильтр: Шины».)
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Машины с совпадающими регистрационными номерами обновляются с сохранением идентификатора и связей с историей.
            Строки без регистрационного номера пропускаются.
          </p>
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wider text-neutral-500">Выбор файла</div>
            <label className="relative flex w-full cursor-pointer items-center justify-center rounded-md border border-dashed border-neutral-300 bg-white px-4 py-3 text-sm text-neutral-700 hover:bg-neutral-50 focus-within:ring-2">
              {importFile ? "Заменить файл Excel" : "Выберите файл .xlsx или .xls…"}
              <input
                type="file"
                accept=".xlsx,.xls"
                aria-label="Выбор файла Excel"
                className="absolute inset-0 w-full cursor-pointer opacity-0"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  setImportFile(f ?? null);
                }}
              />
            </label>
          </div>
        </div>
      </Modal>

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
            <Button
              variant="danger"
              onClick={() => {
                if (deleteTarget) {
                  updateVehicles((list) => list.filter((v) => !deleteTarget.has(v.id)));
                  setSelected(new Set());
                }
                setDeleteOpen(false);
                setDeleteTarget(null);
              }}
            >
              Удалить
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Вы уверены, что хотите удалить выбранные машины ({deleteTarget?.size ?? 0})? Это действие нельзя отменить.
        </p>
      </Modal>

      <ToModal open={toOpen} onClose={() => setToOpen(false)} />
      <GroupEditModal
        open={groupOpen}
        count={selected.size}
        onClose={() => setGroupOpen(false)}
        onApply={(key, value) => {
          selected.forEach((id) => pushEdit({ id, key, value }));
          setGroupOpen(false);
        }}
      />
    </div>
  );
}

function ToModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const current = useAppState((s) => s.settings.toIntervalKm);
  const [value, setValue] = useState(String(current));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Настроить ТО"
      subtitle="Машины с пробегом выше порога отмечаются в статистике"
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button
            onClick={() => {
              const n = Number(value);
              if (!n || n < 0) return;
              setState((s) => ({ ...s, settings: { ...s.settings, toIntervalKm: n } }));
              toast.success("Порог ТО сохранён");
              onClose();
            }}
          >
            Сохранить
          </Button>
        </>
      }
    >
      <Field label="Пробег до ТО, км">
        <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <p className="mt-3 text-xs text-muted-foreground">
        Сейчас превышен у {getState().vehicles.filter((v) => v.mileage >= Number(value || 0)).length} машин.
      </p>
    </Modal>
  );
}

function GroupEditModal({
  open,
  count,
  onClose,
  onApply,
}: {
  open: boolean;
  count: number;
  onClose: () => void;
  onApply: (key: EditableKey, value: string | number) => void;
}) {
  const [key, setKey] = useState<EditableKey>("group");
  const [value, setValue] = useState("");
  const col = COLUMNS.find((c) => c.key === key);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Групповое редактирование"
      subtitle={`Выбрано машин: ${count}`}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={() => onApply(key, col?.numeric ? Number(value) : value)}>Применить</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Поле">
          <Select value={key} onChange={(e) => setKey(e.target.value as EditableKey)}>
            {COLUMNS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Новое значение">
          <Input type={col?.numeric ? "number" : "text"} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
