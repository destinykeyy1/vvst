import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button, Field, Input, Modal } from "@/components/ui-kit";
import { apiGetCollection, apiJournalAction } from "@/lib/api";
import type { JournalEntry, JournalRow } from "@/lib/types";

export const Route = createFileRoute("/journal")({
  component: JournalPage,
});

type Entry = Omit<JournalRow, "id" | "closedAt">;
type FormMode = "departure" | "arrival" | "edit";
type EditorState = { mode: FormMode; row: JournalRow | null; entry: Entry };

type Column = {
  key: keyof Entry;
  label: string;
  width: number;
  type?: "date" | "time" | "number" | "textarea";
};

const MAIN_COLUMNS: Column[] = [
  { key: "date", label: "Дата", width: 112, type: "date" },
  { key: "subdivision", label: "Подразделение", width: 144 },
  {
    key: "driver",
    label: "Фамилия водителя (механика-водителя)",
    width: 192,
  },
  { key: "waybillNumber", label: "Номер путевого листа", width: 144 },
];

const VEHICLE_COLUMNS: Column[] = [
  { key: "brand", label: "Марка (объекта)", width: 176 },
  { key: "regNumber", label: "Регистрационный знак", width: 160 },
];

const DEPARTURE_COLUMNS: Column[] = [
  { key: "departureCondition", label: "Техническое состояние машины", width: 176 },
  { key: "departureSeal", label: "Исправность и опломбирование спидометра", width: 224 },
  { key: "departureOdometer", label: "Показания спидометра", width: 144, type: "number" },
  { key: "departureEngineHours", label: "Показания счётчика моточасов", width: 168, type: "number" },
  { key: "departureTime", label: "Время, ч., мин.", width: 120, type: "time" },
];

const TRIP_COLUMNS: Column[] = [
  { key: "purpose", label: "Цель выезда и маршрут движения", width: 240, type: "textarea" },
  { key: "authority", label: "В чьё распоряжение", width: 176 },
  { key: "returnDeadline", label: "Срок возвращения", width: 144, type: "time" },
];

const ARRIVAL_COLUMNS: Column[] = [
  { key: "arrivalDate", label: "Дата", width: 112, type: "date" },
  { key: "arrivalTime", label: "Время, ч., мин.", width: 120, type: "time" },
  { key: "arrivalCondition", label: "Техническое состояние машины", width: 176 },
  { key: "arrivalSeal", label: "Исправность и опломбирование спидометра", width: 224 },
  { key: "arrivalOdometer", label: "Показания спидометра", width: 144, type: "number" },
  { key: "arrivalEngineHours", label: "Показания счётчика моточасов", width: 168, type: "number" },
];

const REMARKS: Column = {
  key: "remarks",
  label: "Замечания работников МВД и ДНД",
  width: 240,
  type: "textarea",
};

const DUTY_OFFICER: Column = {
  key: "dutySignature",
  label: "Подпись дежурного по парку",
  width: 224,
};

const DEPARTURE_FIELDS: Column[] = [
  ...MAIN_COLUMNS,
  ...VEHICLE_COLUMNS,
  ...DEPARTURE_COLUMNS,
  ...TRIP_COLUMNS,
  DUTY_OFFICER,
];
const ARRIVAL_FIELDS: Column[] = [...ARRIVAL_COLUMNS, REMARKS, DUTY_OFFICER];

const COLUMN_BLOCKS: { label: string; columns: Column[] }[] = [
  { label: "Машина", columns: VEHICLE_COLUMNS },
  { label: "Выезд", columns: [...DEPARTURE_COLUMNS, ...TRIP_COLUMNS] },
  { label: "Прибытие", columns: ARRIVAL_COLUMNS },
  { label: "Примечания", columns: [REMARKS] },
];

const groupedColumns = COLUMN_BLOCKS.flatMap(({ columns }) => columns);
const tableColumns = [...MAIN_COLUMNS, ...groupedColumns, DUTY_OFFICER];
const selectionWidth = 96;
const tableWidth = tableColumns.reduce(
  (width, column) => width + column.width,
  selectionWidth,
);

const EMPTY_ENTRY: Entry = {
  date: "",
  subdivision: "",
  driver: "",
  waybillNumber: "",
  brand: "",
  regNumber: "",

  departureCondition: "ТИ",
  departureSeal: "ОПЛ",
  departureOdometer: null,
  departureEngineHours: null,
  departureTime: "",
  purpose: "",
  authority: "",
  returnDeadline: "18:00",

  arrivalDate: "",
  arrivalTime: "",
  arrivalCondition: "",
  arrivalSeal: "",
  arrivalOdometer: null,
  arrivalEngineHours: null,
  remarks: "",
  dutySignature: "",
  speedometer: null,
};

const FORM_COLUMNS: Record<FormMode, Column[]> = {
  departure: DEPARTURE_FIELDS,
  arrival: ARRIVAL_FIELDS,
  edit: tableColumns,
};

const FORM_TITLES: Record<FormMode, string> = {
  departure: "Выезд машины",
  arrival: "Прибытие / списание машины",
  edit: "Изменить строку",
};

const DEPARTURE_SUMMARY_KEYS = [
  "date",
  "regNumber",
  "brand",
  "departureOdometer",
  "departureEngineHours",
  "departureTime",
  "returnDeadline",
] as const;

type JournalAction =
  | { action: "create"; fields: Partial<Entry> }
  | { action: "return"; id: JournalRow["id"]; fields: Partial<Entry> }
  | { action: "edit"; id: JournalRow["id"]; fields: Partial<Entry>; password?: string }
  | { action: "delete"; id: JournalRow["id"]; password?: string };

function saveJournalAction(action: JournalAction) {
  return apiJournalAction(action);
}

function getFields(entry: Entry, columns: Column[]): Partial<Entry> {
  return Object.fromEntries(
    columns.map(({ key }) => [key, entry[key]]),
  ) as Partial<Entry>;
}

const headerCell =
  "border border-[#d1d1d1] px-3 text-center align-middle text-[12px] font-normal leading-4";
const bodyCell =
  "border border-[#d1d1d1] break-words px-3 py-2.5 align-top leading-5";

function localToday() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function displayDate(value: string) {
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  return date ? `${date[3]}.${date[2]}.${date[1]}` : value;
}

function isClosed(row: JournalRow | null | undefined) {
  const legacyFlag = (row as (JournalRow & { closed?: unknown }) | null | undefined)?.closed;
  return Boolean(row?.closedAt) || legacyFlag === true;
}

function toEntry(row: JournalRow): Entry {
  const { id: _id, closedAt: _closedAt, ...entry } = row;
  return entry;
}

function displayCell(row: JournalEntry, key: keyof Entry) {
  const value = row[key];
  if (value === null || value === undefined || value === "") return "—";
  if (key === "date" || key === "arrivalDate") return displayDate(String(value));
  return String(value);
}

function DepartureSummary({ row }: { row: JournalRow }) {
  return (
    <dl className="mb-5 grid grid-cols-1 gap-3 rounded-md border border-[#e2e2e2] bg-[#fafafa] p-4 sm:grid-cols-2">
      {DEPARTURE_SUMMARY_KEYS.map((key) => {
        const label = DEPARTURE_FIELDS.find((column) => column.key === key)?.label ?? key;
        const value = row[key];
        return (
          <div key={key}>
            <dt className="text-[12px] uppercase text-neutral-500">{label}</dt>
            <dd className="mt-1 text-sm">
              {value === "" ? "—" : (value ?? "—")}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function JournalPage() {
  const [dutyDate, setDutyDate] = useState(localToday);
  const [dutyOfficer, setDutyOfficer] = useState("");
  const [selectedId, setSelectedId] = useState<JournalRow["id"] | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteRow, setDeleteRow] = useState<JournalRow | null>(null);
  const passwordInput = useRef<HTMLInputElement>(null);

  const queryClient = useQueryClient();
  const { data: journal = [], isPending, isError } = useQuery({
    queryKey: ["journal"],
    queryFn: () => apiGetCollection<JournalEntry>("journal"),
  });

  const saveMutation = useMutation({
    mutationFn: saveJournalAction,
    onSuccess: async (rows) => {
      queryClient.setQueryData(["journal"], rows);
      setSelectedId((id) => (rows.some((row) => row.id === id) ? id : null));
      setEditor(null);
      setDeleteRow(null);
      toast.success("Сохранено");
      await queryClient.invalidateQueries({ queryKey: ["journal"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Ошибка сохранения"),
  });

  const selected = journal.find((row) => row.id === selectedId);
  const busy = isPending || isError || saveMutation.isPending;
  const rows = [...journal].sort((a, b) => b.date.localeCompare(a.date));
  const editorNeedsPassword = editor?.mode === "edit" && isClosed(editor.row);
  const deleteNeedsPassword = isClosed(deleteRow);
  const protectedAction = editorNeedsPassword || deleteNeedsPassword;
  const editorColumns = editor ? FORM_COLUMNS[editor.mode] : [];

  function changeField(key: keyof Entry, rawValue: string) {
    const isReading =
      key === "departureOdometer" ||
      key === "departureEngineHours" ||
      key === "arrivalOdometer" ||
      key === "arrivalEngineHours";

    const value = isReading
      ? rawValue.trim() === ""
        ? null
        : Number(rawValue)
      : rawValue;

    if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
      return;
    }

    setEditor((current) => {
      if (!current) return current;
      return { ...current, entry: { ...current.entry, [key]: value } as Entry };
    });
  }

  function openEditor(mode: FormMode, row: JournalRow | null = null) {
    setEditor({
      mode,
      row,
      entry: row ? toEntry(row) : { ...EMPTY_ENTRY },
    });
    setDeleteRow(null);
  }

  function handleAdd() {
    openEditor("departure");
    setEditor((current) =>
      current && {
        ...current,
        entry: {
          ...current.entry,
          date: dutyDate || localToday(),
          dutySignature: dutyOfficer.trim(),
        },
      },
    );
  }

  function handleReturn() {
    if (!selected || isClosed(selected)) return;

    setEditor({
      mode: "arrival",
      row: selected,
      entry: {
        ...EMPTY_ENTRY,
        ...toEntry(selected),
        arrivalDate: selected.arrivalDate || dutyDate || localToday(),
        arrivalCondition: selected.arrivalCondition || "ТИ",
        arrivalSeal: selected.arrivalSeal || "ОПЛ",
        dutySignature: dutyOfficer.trim() || selected.dutySignature || "",
      },
    });
    setDeleteRow(null);
  }

  function handleEdit() {
    if (!selected) return;
    openEditor("edit", selected);
  }

  function handleDelete() {
    if (!selected) return;
    setDeleteRow(selected);
    setEditor(null);
  }

  function closeModal() {
    if (saveMutation.isPending) return;
    setEditor(null);
    setDeleteRow(null);
  }

  function handleSave() {
    if (busy) return;

    const password = protectedAction ? passwordInput.current?.value : undefined;

    if (protectedAction && !password) {
      toast.error("Введите пароль");
      return;
    }

    if (deleteRow) {
      saveMutation.mutate({ action: "delete", id: deleteRow.id, password });
      return;
    }

    if (!editor) return;

    const { mode, row, entry } = editor;
    const regNumber = entry.regNumber.trim();

    if (mode !== "arrival" && (!entry.date || !regNumber)) {
      toast.error("Заполните дату и регистрационный знак");
      return;
    }

    if ((mode === "arrival" || isClosed(row)) && (!entry.arrivalDate || !entry.arrivalTime)) {
      toast.error("Заполните дату и время прибытия");
      return;
    }

    if (mode === "departure") {
      saveMutation.mutate({
        action: "create",
        fields: getFields({ ...entry, regNumber }, DEPARTURE_FIELDS),
      });
      return;
    }

    if (!row) return;

    if (mode === "arrival") {
      saveMutation.mutate({
        action: "return",
        id: row.id,
        fields: getFields(entry, ARRIVAL_FIELDS),
      });
      return;
    }

    saveMutation.mutate({
      action: "edit",
      id: row.id,
      fields: getFields(
        { ...entry, regNumber },
        isClosed(row) ? [...DEPARTURE_FIELDS, ...ARRIVAL_FIELDS] : DEPARTURE_FIELDS,
      ),
      password,
    });
  }

  return (
    <section className="w-full min-w-0 text-[#191919]">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-[18px] font-semibold uppercase tracking-[0.04em]">
          Журнал выхода и возвращения машин
        </h1>

        <div className="flex flex-wrap gap-2">
          <Button className="h-[38px] rounded-md" onClick={handleAdd} disabled={busy}>
            Добавить выезд
          </Button>
          <Button
            variant="outline"
            className="h-[38px] rounded-md"
            onClick={handleReturn}
            disabled={busy || !selected || isClosed(selected)}
          >
            Списать машину
          </Button>
          <Button
            variant="outline"
            className="h-[38px] rounded-md"
            onClick={handleEdit}
            disabled={busy || !selected}
          >
            Изменить строку
          </Button>
          <Button
            variant="outline"
            className="h-[38px] rounded-md border-red-200 text-red-600"
            onClick={handleDelete}
            disabled={busy || !selected}
          >
            Удалить строку
          </Button>
        </div>
      </header>

      <div
        role="region"
        aria-label="Журнал выхода и возвращения машин"
        tabIndex={0}
        className="max-w-full overflow-x-auto rounded-t-lg border border-[#e2e2e2] [container-type:inline-size]"
      >
        <table
          className="table-fixed border-collapse text-[13px]"
          style={{ width: tableWidth, minWidth: "100%" }}
        >
          <colgroup>
            <col style={{ width: selectionWidth }} />
            {MAIN_COLUMNS.map(({ key, width }) => (
              <col key={key} style={{ width }} />
            ))}
          </colgroup>
          {COLUMN_BLOCKS.map(({ label, columns }) => (
            <colgroup key={label}>
              {columns.map(({ key, width }) => (
                <col key={key} style={{ width }} />
              ))}
            </colgroup>
          ))}
          <colgroup>
            <col style={{ width: DUTY_OFFICER.width }} />
          </colgroup>

          <thead className="bg-[#f7f7f7]">
            <tr className="h-[41px]">
              <th rowSpan={2} scope="col" className={headerCell}>
                Выбор
              </th>
              {MAIN_COLUMNS.map(({ key, label }) => (
                <th key={key} rowSpan={2} scope="col" className={headerCell}>
                  {label}
                </th>
              ))}
              {COLUMN_BLOCKS.map(({ label, columns }) => (
                <th key={label} colSpan={columns.length} scope="colgroup" className={headerCell}>
                  {label}
                </th>
              ))}
              <th rowSpan={2} scope="col" className={headerCell}>
                {DUTY_OFFICER.label}
              </th>
            </tr>
            <tr className="h-[57px]">
              {groupedColumns.map(({ key, label }) => (
                <th key={key} scope="col" className={headerCell}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            <tr className="bg-[#fcf9e9]">
              <td colSpan={tableColumns.length + 1} className="border-y border-[#efda83] p-0">
                <div className="sticky left-0 flex w-full max-w-[100cqw] flex-wrap items-end gap-3 px-3 py-3">
                  <label className="block w-[132px] shrink-0">
                    <span className="mb-0.5 block text-[12px] uppercase text-neutral-500">
                      Дата
                    </span>
                    <Input
                      type="date"
                      className="h-[38px] w-full bg-white"
                      value={dutyDate}
                      onChange={(event) => setDutyDate(event.target.value)}
                    />
                  </label>
                  <label className="block min-w-[min(220px,100%)] flex-1">
                    <span className="mb-0.5 block text-[12px] uppercase text-neutral-500">
                      Дежурный по парку (фамилия и инициалы)
                    </span>
                    <Input
                      className="h-[38px] w-full bg-transparent"
                      placeholder="Например: Иванов И.И."
                      value={dutyOfficer}
                      onChange={(event) => setDutyOfficer(event.target.value)}
                    />
                  </label>
                </div>
              </td>
            </tr>

            {rows.map((row) => (
              <tr
                key={row.id}
                className={`h-[57px] ${row.id === selectedId ? "bg-neutral-100" : "bg-white"}`}
              >
                <td className="border border-[#d1d1d1] text-center align-middle">
                  <input
                    type="checkbox"
                    className="h-4 w-4 align-middle accent-neutral-900"
                    aria-label={`Выбрать строку: ${row.regNumber}, ${displayDate(row.date)}`}
                    checked={row.id === selectedId}
                    onChange={(event) => setSelectedId(event.target.checked ? row.id : null)}
                  />
                </td>
                {tableColumns.map(({ key }) => (
                  <td key={key} className={bodyCell}>
                    {displayCell(row, key)}
                  </td>
                ))}
              </tr>
            ))}

            {rows.length === 0 && (
              <tr>
                <td colSpan={tableColumns.length + 1} className="p-0">
                  <p className="sticky left-0 w-full max-w-[100cqw] px-3 py-8 text-center text-neutral-500">
                    {isPending
                      ? "Загрузка журнала…"
                      : isError
                        ? "Не удалось загрузить журнал"
                        : "Записей в журнале нет"}
                  </p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={editor !== null}
        onClose={closeModal}
        title={editor ? FORM_TITLES[editor.mode] : ""}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={closeModal} disabled={saveMutation.isPending}>
              Отмена
            </Button>
            <Button onClick={handleSave} disabled={busy}>
              {saveMutation.isPending ? "Сохранение…" : "Сохранить"}
            </Button>
          </>
        }
      >
        {editor && (
          <div>
            {editor.mode === "arrival" && editor.row && <DepartureSummary row={editor.row} />}
            {protectedAction && (
              <Field label="Пароль для изменения записи" className="mb-4">
                <Input
                  ref={passwordInput}
                  type="password"
                  autoComplete="current-password"
                  disabled={saveMutation.isPending}
                />
              </Field>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {editorColumns.map(({ key, label, type }) => (
                <Field
                  key={key}
                  label={label}
                  className={type === "textarea" ? "sm:col-span-2" : undefined}
                >
                  {type === "textarea" ? (
                    <textarea
                      rows={3}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                      value={String(editor.entry[key] ?? "")}
                      disabled={saveMutation.isPending}
                      onChange={(event) =>
                        setEditor((current) =>
                          current && {
                            ...current,
                            entry: { ...current.entry, [key]: event.target.value } as Entry,
                          },
                        )
                      }
                    />
                  ) : (
                    <Input
                      type={type ?? "text"}
                      value={editor.entry[key] === null || editor.entry[key] === undefined ? "" : String(editor.entry[key])}
                      disabled={saveMutation.isPending}
                      onChange={(event) => changeField(key, event.target.value)}
                    />
                  )}
                </Field>
              ))}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={deleteRow !== null}
        onClose={closeModal}
        title="Подтверждение удаления"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={closeModal} disabled={saveMutation.isPending}>
              Отмена
            </Button>
            <Button variant="danger" onClick={handleSave} disabled={busy}>
              {saveMutation.isPending ? "Удаление…" : "Удалить"}
            </Button>
          </>
        }
      >
        {deleteRow && (
          <div>
            <p className="text-sm">
              Удалить запись от {displayDate(deleteRow.date)} для машины {deleteRow.regNumber}?
            </p>
            {protectedAction && (
              <Field label="Пароль для удаления записи" className="mt-4">
                <Input
                  ref={passwordInput}
                  type="password"
                  autoComplete="current-password"
                  disabled={saveMutation.isPending}
                />
              </Field>
            )}
          </div>
        )}
      </Modal>
    </section>
  );
}
