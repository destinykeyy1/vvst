import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpDown } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PasswordGate } from "@/components/PasswordGate";
import { Button, Field, Input, Modal, PageHeader, Panel, Select } from "@/components/ui-kit";
import { TYPE_LABELS, VehicleFormModal } from "@/components/VehicleForm";
import { exportRowsToExcel, pickString, readExcelRows } from "@/lib/excel";
import { formatNumber } from "@/lib/logic";
import { getState, nextVehicleId, setState, updateVehicles, useAppState } from "@/lib/store";
import type { Vehicle, VehicleType, WriteOffKind } from "@/lib/types";
import { cn } from "@/lib/utils";

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

type EditableKey = "unit" | "brand" | "year" | "commissionDate" | "order" | "plate" | "group" | "assignedTo" | "mileage" | "motoHours";

interface Column {
  key: EditableKey;
  label: string;
  width: number;
  numeric?: boolean;
  align?: "center";
}

const COLUMNS: Column[] = [
  { key: "unit", label: "Подразделение", width: 160 },
  { key: "brand", label: "Марка машины", width: 160 },
  { key: "year", label: "Год выпуска", width: 95, numeric: true },
  { key: "commissionDate", label: "Дата ввода в эксплуатацию", width: 190 },
  { key: "order", label: "Наряд на получение (передачу) ВВСТ", width: 240, align: "center" },
  { key: "plate", label: "Государственный регистрационный знак (строевой номер)", width: 240, align: "center" },
  { key: "group", label: "Группа эксплуатации", width: 160, align: "center" },
  { key: "assignedTo", label: "Закреплённый водитель", width: 200 },
  { key: "mileage", label: "Пробег, км", width: 120, numeric: true },
  { key: "motoHours", label: "Моточасы", width: 110, numeric: true },
];

interface Edit {
  id: number;
  key: EditableKey;
  value: string | number;
}

const WRITE_OFF_FILTERS: { label: string; kind: WriteOffKind; match?: RegExp }[] = [
  { label: "АКБ", kind: "akb" },
  { label: "Шины", kind: "tires" },
  { label: "ТШ-З", kind: "headsets", match: /ТШ-?З|зимн/i },
  { label: "ТШ-Л", kind: "headsets", match: /ТШ-?Л|летн/i },
  { label: "Тенты", kind: "tarps", match: /тент/i },
  { label: "Брезенты", kind: "tarps", match: /брезент/i },
];

function VvstPage() {
  const vehicles = useAppState((s) => s.vehicles);
  const writeOffs = useAppState((s) => s.writeOffs);
  const toInterval = useAppState((s) => s.settings.toIntervalKm);

  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | VehicleType>("all");
  const [woFilter, setWoFilter] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<EditableKey>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [sort, setSort] = useState<{ key: EditableKey | "n"; dir: 1 | -1 }>({ key: "n", dir: 1 });
  const [edits, setEdits] = useState<Edit[]>([]);
  const [redo, setRedo] = useState<Edit[]>([]);
  const [editing, setEditing] = useState<{ id: number; key: EditableKey } | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [toOpen, setToOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const withEdits = useMemo(() => {
    const map = new Map<number, Vehicle>();
    vehicles.forEach((v) => map.set(v.id, v));
    for (const e of edits) {
      const v = map.get(e.id);
      if (v) map.set(e.id, { ...v, [e.key]: e.value });
    }
    return vehicles.map((v) => map.get(v.id) ?? v);
  }, [vehicles, edits]);

  const editedCells = useMemo(() => new Set(edits.map((e) => `${e.id}:${e.key}`)), [edits]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filter = WRITE_OFF_FILTERS.find((f) => f.label === woFilter);
    const woIds = filter
      ? new Set(
          writeOffs.filter((w) => w.kind === filter.kind && (!filter.match || filter.match.test(w.item))).map((w) => w.vehicleId),
        )
      : null;
    const list = withEdits
      .map((v, i) => ({ v, n: i + 1 }))
      .filter(({ v }) => (type === "all" || v.type === type) && (!q || v.brand.toLowerCase().includes(q) || v.plate.toLowerCase().includes(q)))
      .filter(({ v }) => !woIds || woIds.has(v.id));
    if (sort.key !== "n") {
      const k = sort.key;
      list.sort((a, b) => (String(a.v[k]) > String(b.v[k]) ? 1 : String(a.v[k]) < String(b.v[k]) ? -1 : 0) * sort.dir);
    } else if (sort.dir === -1) list.reverse();
    return list;
  }, [withEdits, query, type, woFilter, writeOffs, sort]);

  const visibleCols = COLUMNS.filter((c) => !hidden.has(c.key));

  const pushEdit = (e: Edit) => {
    setEdits((prev) => [...prev, e]);
    setRedo([]);
  };

  const save = () => {
    const finalMap = new Map(withEdits.map((v) => [v.id, v]));
    updateVehicles((list) => list.map((v) => finalMap.get(v.id) ?? v));
    toast.success(`Сохранено изменений: ${edits.length}`);
    setEdits([]);
    setRedo([]);
  };

  const toggleSort = (key: EditableKey | "n") =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  const allSelected = rows.length > 0 && rows.every(({ v }) => selected.has(v.id));

  const importExcel = async (file: File) => {
    const data = await readExcelRows(file);
    let nextId = nextVehicleId();
    const added: Vehicle[] = data
      .map((r) => ({
        id: nextId++,
        unit: pickString(r, "Подразделение") || "1 АО (учебное) отдела (УБМ)",
        brand: pickString(r, "Марка машины", "Марка"),
        year: Number(pickString(r, "Год выпуска", "Год")) || new Date().getFullYear(),
        commissionDate: pickString(r, "Дата ввода в эксплуатацию"),
        order: pickString(r, "Наряд", "Наряд на получение (передачу) ВВСТ"),
        plate: pickString(r, "Государственный регистрационный знак", "Гос. номер", "Номер"),
        group: pickString(r, "Группа эксплуатации", "Группа") || "УЧ",
        assignedTo: pickString(r, "Закреплённый водитель", "Водитель"),
        type: "auto" as VehicleType,
        status: "ready" as const,
        statusReason: "",
        mileage: Number(pickString(r, "Пробег", "Пробег, км")) || 0,
        motoHours: Number(pickString(r, "Моточасы")) || 0,
        details: {},
      }))
      .filter((v) => v.brand && v.plate);
    updateVehicles((list) => [...list, ...added]);
    toast.success(added.length ? `Импортировано машин: ${added.length}` : "В файле не найдено машин (нужны столбцы «Марка машины» и «Государственный регистрационный знак»)");
  };

  const exportAct = () => {
    const list = withEdits.filter((v) => selected.has(v.id));
    void exportRowsToExcel(
      "Акт_тех_состояния.xlsx",
      list.map((v, i) => ({
        "№": i + 1,
        "Марка машины": v.brand,
        "Гос. рег. знак": v.plate,
        "Подразделение": v.unit,
        "Пробег, км": v.mileage,
        "Моточасы": v.motoHours,
        "Техническое состояние": v.status === "ready" ? "Исправна" : v.status === "repair" ? "В ремонте" : "Недоступна",
        "До ТО, км": Math.max(0, toInterval - v.mileage),
      })),
    );
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
        <Button variant="outline" onClick={() => setColsOpen(true)}>
          Столбцы
        </Button>
        {WRITE_OFF_FILTERS.map((f) => (
          <Button
            key={f.label}
            variant={woFilter === f.label ? "default" : "outline"}
            onClick={() => setWoFilter((cur) => (cur === f.label ? null : f.label))}
          >
            Фильтр: {f.label}
          </Button>
        ))}
        <Button variant="outline" onClick={() => setSelected(allSelected ? new Set() : new Set(rows.map(({ v }) => v.id)))}>
          {allSelected ? "Снять выбор" : "Выбрать все машины"}
        </Button>
        <Button
          variant="danger"
          disabled={selected.size === 0}
          onClick={() => {
            if (!window.confirm(`Удалить выбранные машины (${selected.size})?`)) return;
            updateVehicles((list) => list.filter((v) => !selected.has(v.id)));
            setSelected(new Set());
          }}
        >
          Удалить выбранные
        </Button>
        <Button variant="outline" onClick={() => window.print()}>
          Экспорт PDF
        </Button>
        <Button onClick={() => fileRef.current?.click()}>Импорт Excel</Button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importExcel(f);
            e.target.value = "";
          }}
        />
      </Panel>

      <Panel className="thin-scroll max-h-[calc(100vh-20rem)] overflow-auto">
        <table className="w-max min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr className="border-b border-border">
              <th className="w-12 px-3 py-3">
                <input
                  type="checkbox"
                  aria-label="Выбрать все"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map(({ v }) => v.id)))}
                />
              </th>
              <HeaderCell n={1} label="№ п/п" width={70} onSort={() => toggleSort("n")} />
              {visibleCols.map((c) => (
                <HeaderCell key={c.key} n={COLUMNS.indexOf(c) + 2} label={c.label} width={c.width} center={c.align === "center"} onSort={() => toggleSort(c.key)} />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ v, n }) => (
              <tr key={v.id} className={cn("border-b border-border", selected.has(v.id) && "bg-accent")}>
                <td className="px-3 py-3 text-center">
                  <input
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
                <td className="px-3 py-3">{n}</td>
                {visibleCols.map((c) => {
                  const isEditing = editing?.id === v.id && editing.key === c.key;
                  const raw = v[c.key];
                  const display = raw === "" ? "—" : c.numeric ? formatNumber(Number(raw)) : String(raw);
                  return (
                    <td
                      key={c.key}
                      style={{ minWidth: c.width, maxWidth: c.width }}
                      className={cn("px-3 py-3 align-top", editedCells.has(`${v.id}:${c.key}`) && "bg-warning-soft")}
                    >
                      {isEditing ? (
                        <Input
                          autoFocus
                          defaultValue={String(raw)}
                          type={c.numeric ? "number" : "text"}
                          className="h-8"
                          onBlur={(e) => {
                            const value = c.numeric ? Number(e.target.value) : e.target.value;
                            if (value !== raw) pushEdit({ id: v.id, key: c.key, value });
                            setEditing(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                            if (e.key === "Escape") setEditing(null);
                          }}
                        />
                      ) : (
                        <div className="flex items-start justify-between gap-2">
                          <span className={cn("flex-1", c.align === "center" && "text-center")}>{display}</span>
                          <button className="no-print shrink-0 text-xs text-subtle hover:text-foreground" onClick={() => setEditing({ id: v.id, key: c.key })}>
                            Изм.
                          </button>
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={visibleCols.length + 2} className="py-10 text-center text-muted-foreground">
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
        <Button variant="outline" disabled={selected.size === 0} onClick={exportAct}>
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

      <Modal open={colsOpen} onClose={() => setColsOpen(false)} title="Столбцы" size="sm">
        <div className="flex flex-col gap-2.5">
          {COLUMNS.map((c) => (
            <label key={c.key} className="flex items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={!hidden.has(c.key)}
                onChange={() =>
                  setHidden((h) => {
                    const next = new Set(h);
                    if (next.has(c.key)) next.delete(c.key);
                    else next.add(c.key);
                    return next;
                  })
                }
              />
              {c.label}
            </label>
          ))}
        </div>
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

function HeaderCell({ n, label, width, center, onSort }: { n: number; label: string; width: number; center?: boolean; onSort: () => void }) {
  return (
    <th style={{ minWidth: width, maxWidth: width }} className="th-cell px-3 py-3 align-middle">
      <button onClick={onSort} className={cn("flex w-full items-center gap-2 text-left", center && "justify-center text-center")}>
        <span>
          <span className="block text-[10px] text-muted-foreground">№ {n}</span>
          {label}
        </span>
        <ArrowUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      </button>
    </th>
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
