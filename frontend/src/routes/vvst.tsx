import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PasswordGate } from "@/components/PasswordGate";
import { Button, Field, Input, Modal, PageHeader, Panel, Select } from "@/components/ui-kit";
import { TYPE_LABELS, VehicleFormModal } from "@/components/VehicleForm";
import { exportRowsToExcel } from "@/lib/excel";
import {
  PASSPORT_COLUMN_COUNT,
  PASSPORT_HEADERS,
  exportPassportExcel,
  importPassportExcel,
  vehicleToPassportRow,
} from "@/lib/passportExcel";
import { formatNumber } from "@/lib/logic";
import { getState, nextVehicleId, setState, updateVehicles, useAppState } from "@/lib/store";
import type { Vehicle, VehicleType, WriteOffKind } from "@/lib/types";
import { cn } from "@/lib/utils";

const columnWidths = [76, 160, 160, 96, 208, 240, 240, 240];

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
const EDITABLE_BY_COL: Record<number, EditableKey> = {
  1: "unit",
  2: "brand",
  3: "year",
  4: "commissionDate",
  5: "order",
  6: "plate",
  7: "group",
  8: "assignedTo",
  95: "mileage",
  102: "motoHours",
};

const NUMERIC_COLS = new Set([3, 95, 102]);

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
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [edits, setEdits] = useState<Edit[]>([]);
  const [redo, setRedo] = useState<Edit[]>([]);
  const [editing, setEditing] = useState<{ id: number; key: EditableKey } | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [toOpen, setToOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importUpdate, setImportUpdate] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Set<number> | null>(null);

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
      .filter((v) => (type === "all" || v.type === type) && (!q || v.brand.toLowerCase().includes(q) || v.plate.toLowerCase().includes(q)))
      .filter((v) => !woIds || woIds.has(v.id));
    return list.map((v, i) => ({ v, cells: vehicleToPassportRow(v, toInterval, i) }));
  }, [withEdits, query, type, woFilter, writeOffs, toInterval]);

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

  const allSelected = rows.length > 0 && rows.every(({ v }) => selected.has(v.id));

  const importExcel = async () => {
    if (!importFile) {
      toast.error("Выберите файл");
      return;
    }
    try {
      const baseId = nextVehicleId();
      const added = await importPassportExcel(importFile, baseId);
      if (!added.length) {
        toast.error("В файле не найдено машин (нужны столбцы «Подразделение» и «Марка машины»)");
        return;
      }
      if (importUpdate) {
        updateVehicles((list) => {
          const existingMap = new Map(list.map((v) => [v.plate, v]));
          const final = [...list];
          for (const v of added) {
            const existing = existingMap.get(v.plate);
            if (existing) {
              final[final.indexOf(existing)] = { ...existing, ...v, id: existing.id };
            } else {
              final.push(v);
            }
          }
          return final;
        });
        toast.success(`Обновлено машин: ${added.length}`);
      } else {
        updateVehicles((list) => [...list, ...added]);
        toast.success(`Импортировано машин: ${added.length}`);
      }
      setImportOpen(false);
      setImportFile(null);
    } catch {
      toast.error("Не удалось прочитать файл Excel");
    }
  };

  const exportVvst = () => {
    const list = selected.size ? withEdits.filter((v) => selected.has(v.id)) : withEdits;
    void exportPassportExcel("Электронный_паспорт_ВВСТ.xlsx", list, toInterval).then(
      () => toast.success(`Экспортировано машин: ${list.length}`),
      () => toast.error("Не удалось экспортировать файл"),
    );
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
            setDeleteTarget(selected);
            setDeleteOpen(true);
          }}
        >
          Удалить выбранные
        </Button>
        <Button variant="outline" onClick={() => window.print()}>
          Экспорт PDF
        </Button>
        <Button variant="outline" onClick={exportVvst}>
          Экспорт ВВСТ
        </Button>
        <Button onClick={() => setImportOpen(true)}>Импорт Excel</Button>
      </Panel>

      <Panel className="thin-scroll max-h-[calc(100vh-20rem)] overflow-auto">
        <table className="w-max min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr className="border-b border-border">
              <th className="w-12 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Выбрать все"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map(({ v }) => v.id)))}
                />
              </th>
              {PASSPORT_HEADERS.map((label, i) => (
                <th key={i} style={{ width: columnWidths[i] ?? 160 }} className={cn("px-2 py-3 align-middle text-xs font-normal tracking-wide text-neutral-500", i < 5 ? "text-left" : "text-center")}>
                  <span className="block text-[10px] text-muted-foreground">№ {i + 1}</span>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ v, cells }) => (
              <tr key={v.id} className={cn("border-b border-neutral-100", selected.has(v.id) ? "bg-accent" : "even:bg-neutral-50")}>
                <td className="px-3 py-2 text-center align-top">
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
                {cells.map((raw, col) => {
                  const editKey = EDITABLE_BY_COL[col];
                  const isEditing = editKey !== undefined && editing?.id === v.id && editing.key === editKey;
                  const display = raw === "" || raw === null || raw === undefined ? "" : NUMERIC_COLS.has(col) ? formatNumber(Number(raw)) : String(raw);
                  const numeric = editKey ? COLUMNS.find((c) => c.key === editKey)?.numeric : false;
                  const edited = editKey !== undefined && editedCells.has(`${v.id}:${editKey}`);
                  return (
                    <td
                      key={col}
                      style={{ width: columnWidths[col] ?? 160, maxWidth: columnWidths[col] ?? 160 }}
                      className={cn("px-2 py-2 align-middle text-sm", col >= 5 && "text-center", edited && "bg-warning-soft")}
                    >
                      {isEditing ? (
                        <Input
                          autoFocus
                          defaultValue={String(v[editKey as EditableKey] ?? "")}
                          type={numeric ? "number" : "text"}
                          className="h-7 w-full text-xs"
                          onBlur={(e) => {
                            const value = numeric ? Number(e.target.value) : e.target.value;
                            if (value !== v[editKey as EditableKey]) pushEdit({ id: v.id, key: editKey, value });
                            setEditing(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                            if (e.key === "Escape") setEditing(null);
                          }}
                        />
                      ) : (
                        <div className="flex items-start justify-between gap-1">
                          <span className="flex-1 whitespace-pre-wrap break-words">{display}</span>
                          {editKey !== undefined && (
                            <button
                              className="no-print shrink-0 text-[10px] text-subtle hover:text-foreground"
                              onClick={() => setEditing({ id: v.id, key: editKey })}
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
                <td colSpan={PASSPORT_COLUMN_COUNT + 1} className="py-10 text-center text-muted-foreground">
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
            <Button onClick={importExcel} disabled={!importFile}>
              Импортировать
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
              Сроки действия выделяются красным. (Срок службы аккумуляторной батареи выделяется по достижении 4 лет, а износ шин — при отрицательном остатке ресурса. Для быстрого просмотра используйте фильтры «Фокус: АКБ» и «Фокус: шины».)
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={importUpdate} onChange={(e) => setImportUpdate(e.target.checked)} />
            Обновлять существующие машины (по гос. номеру)
          </label>
          <p className="text-xs text-muted-foreground">
            Для обновления паспорта удалять машины не нужно. Обновление по госномеру сохраняет идентификаторы и связи с историей. Формулы загружаются из нового Excel-файла.
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
