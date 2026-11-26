import { currentEngineHours } from "@/lib/engineHours";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, Field, Input, Modal } from "@/components/ui-kit";
import { apiGetCollection, apiJournalAction } from "@/lib/api";
import { setState } from "@/lib/store";
import { vehicleFromDto } from "@/lib/backendMap";
import type { JournalEntry, JournalRow, VehicleDto } from "@/lib/types";

export const Route = createFileRoute("/journal")({
  component: JournalPage,
});

type Entry = Omit<JournalRow, "id" | "closedAt">;
type FormMode = "departure" | "arrival" | "edit";
type EditorState = { mode: FormMode; row: JournalRow | null; entry: Entry };

type RegistryVehicle = {
  id: number;
  brand: string;
  regNumber: string;
  location: string;
  currentMileage: number;
  passportData?: { header: string; value: unknown }[] | null;
};

type RegistryVehicleDetails = {
  vehicleId: number;
  certificate: { subdivision?: string } | null;
};

const formLabel = "block text-xs font-normal uppercase leading-4 text-[#737373]";
const formSelect =
  "h-[38px] w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";
const returnDeadlines = ["15:00", "18:00"];

const fieldLabels: Partial<Record<keyof Entry, string>> = {
  date: "Дата записи",
  driver: "Фамилия водителя",
  brand: "Марка машины",
  departureOdometer: "Показания спидометра при выезде",
  departureEngineHours: "Показания моточасов при выезде",
  departureTime: "Время выезда",
  arrivalDate: "Дата прибытия",
  arrivalTime: "Время прибытия",
  arrivalOdometer: "Показания спидометра при возвращении",
  arrivalEngineHours: "Показания моточасов при возвращении",
};

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
  departure: "Добавить строку",
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

function arrivalValidationError(entry: Entry) {
  if (entry.arrivalDate && entry.arrivalDate < entry.date) {
    return "Дата прибытия не может быть раньше даты выезда";
  }
  if (entry.arrivalDate === entry.date && entry.departureTime &&
      entry.arrivalTime && entry.arrivalTime < entry.departureTime) {
    return "Время прибытия в день выезда не может быть раньше времени выезда";
  }
  if (entry.arrivalOdometer != null && entry.departureOdometer != null &&
      entry.arrivalOdometer < entry.departureOdometer) {
    return "Показание спидометра при прибытии не может быть меньше показания при выезде";
  }
  if (entry.arrivalEngineHours != null && entry.departureEngineHours != null &&
      entry.arrivalEngineHours < entry.departureEngineHours) {
    return "Показание моточасов при прибытии не может быть меньше показания при выезде";
  }
  return null;
}

function JournalPage() {
  const [dutyDate, setDutyDate] = useState(localToday);
  const [dutyOfficer, setDutyOfficer] = useState("");
  const [selectedId, setSelectedId] = useState<JournalRow["id"] | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteRow, setDeleteRow] = useState<JournalRow | null>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const verifiedPassword = useRef<string | undefined>(undefined);
  const [passwordRequest, setPasswordRequest] = useState<{
    action: "edit" | "delete";
    row: JournalRow;
  } | null>(null);
  const [checkingPassword, setCheckingPassword] = useState(false);

  const queryClient = useQueryClient();
  const { data: journal = [], isPending, isError } = useQuery({
    queryKey: ["journal"],
    queryFn: () => apiGetCollection<JournalEntry>("journal"),
  });

  const showRegistry = editor !== null && editor.mode !== "arrival";
  const vehiclesQuery = useQuery({
    queryKey: ["vehicles"],
    queryFn: () => apiGetCollection<VehicleDto>("vehicles"),
    refetchOnMount: "always",
    enabled: showRegistry,
  });
  const detailsQuery = useQuery({
    queryKey: ["journal-vehicle-details"],
    queryFn: () => apiGetCollection<RegistryVehicleDetails>("vehicle-details"),
    enabled: showRegistry,
  });

  const subdivisionById = new Map(
    (detailsQuery.data ?? []).map(({ vehicleId, certificate }) => [
      vehicleId,
      certificate?.subdivision?.trim(),
    ] as const),
  );
  const fleet = (vehiclesQuery.data ?? []).map((vehicle) => ({
    ...vehicle,
    subdivision: subdivisionById.get(vehicle.id) || vehicle.location.trim(),
  }));
  const subdivisions = [...new Set(
    [editor?.entry.subdivision, ...fleet.map((vehicle) => vehicle.subdivision)]
      .filter((value): value is string => Boolean(value)),
  )].sort((a, b) => a.localeCompare(b, "ru"));
  const subdivision = editor?.entry.subdivision;
  const availableVehicles = subdivision
    ? fleet.filter((vehicle) => vehicle.subdivision === subdivision)
    : [];
  const registryLoading = vehiclesQuery.isPending || detailsQuery.isPending;
  const registryFailed = vehiclesQuery.isError || detailsQuery.isError;

  const saveMutation = useMutation({
    mutationFn: saveJournalAction,
    onSuccess: async (rows, action) => {
      queryClient.setQueryData(["journal"], rows);
      setSelectedId((id) => (rows.some((row) => row.id === id) ? id : null));
      setEditor(null);
      setDeleteRow(null);
      verifiedPassword.current = undefined;
      toast.success("Сохранено");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["journal"] }),
        queryClient.invalidateQueries({ queryKey: ["exploitation"] }),
        queryClient.invalidateQueries({ queryKey: ["vehicles"] }),
      ]);
      if (action.action === "return" || action.action === "edit") {
        try {
          const fleet = await queryClient.fetchQuery({
            queryKey: ["vehicles"],
            queryFn: () => apiGetCollection<VehicleDto>("vehicles"),
          });
          setState(state => ({ ...state, vehicles: fleet.map(vehicleFromDto) }));
        } catch {
          toast.error("Запись сохранена. Не удалось обновить перечень ВВСТ.");
        }
      }
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Ошибка сохранения"),
  });

  const selected = journal.find((row) => row.id === selectedId);
  const busy = isPending || isError || saveMutation.isPending;
  const rows = [...journal].sort((a, b) => b.date.localeCompare(a.date));
  const editorColumns = editor
    ? FORM_COLUMNS[editor.mode].filter(({ key }) => key !== "dutySignature")
    : [];
  const selectedVehicle = availableVehicles.find(
    (vehicle) => vehicle.regNumber === editor?.entry.regNumber &&
      vehicle.brand === editor?.entry.brand,
  );

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

  function changeSubdivision(value: string) {
    setEditor((current) => current && {
      ...current,
      entry: {
        ...current.entry,
        subdivision: value,
        brand: "",
        regNumber: "",
        departureOdometer: null,
        departureEngineHours: null,
      },
    });
  }

  function chooseVehicle(value: string) {
    const vehicle = availableVehicles.find(({ id }) => String(id) === value);
    if (!vehicle) return;

    setEditor((current) => current && {
      ...current,
      entry: {
        ...current.entry,
        brand: vehicle.brand,
        regNumber: vehicle.regNumber,
        departureOdometer: vehicle.currentMileage,
        departureEngineHours: currentEngineHours(vehicle),
      },
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

  function requestPassword(action: "edit" | "delete") {
    if (!selected) return;
    verifiedPassword.current = undefined;
    setPasswordRequest({ action, row: selected });
  }

  async function confirmPassword() {
    if (!passwordRequest || checkingPassword) return;
    const password = passwordInput.current?.value;
    if (!password) {
      toast.error("Введите пароль");
      return;
    }

    setCheckingPassword(true);
    try {
      const response = await fetch("/api/journal/verify-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Не удалось проверить пароль");
      }

      verifiedPassword.current = password;
      setPasswordRequest(null);
      if (passwordRequest.action === "edit") {
        openEditor("edit", passwordRequest.row);
      } else {
        setDeleteRow(passwordRequest.row);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось проверить пароль");
    } finally {
      setCheckingPassword(false);
    }
  }

  function closeModal() {
    if (saveMutation.isPending || checkingPassword) return;
    verifiedPassword.current = undefined;
    setPasswordRequest(null);
    setEditor(null);
    setDeleteRow(null);
  }

  function handleSave() {
    if (busy) return;

    const password = verifiedPassword.current;

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

    if (mode === "arrival" || isClosed(row)) {
      const error = arrivalValidationError(entry);
      if (error) {
        toast.error(error);
        return;
      }
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
            onClick={() => requestPassword("edit")}
            disabled={busy || !selected}
          >
            Изменить строку
          </Button>
          <Button
            variant="outline"
            className="h-[38px] rounded-md border-red-200 text-red-600"
            onClick={() => requestPassword("delete")}
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
        open={passwordRequest !== null}
        onClose={closeModal}
        title={passwordRequest?.action === "delete" ? "Пароль для удаления" : "Пароль для изменения"}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={closeModal} disabled={checkingPassword}>
              Отмена
            </Button>
            <Button onClick={confirmPassword} disabled={checkingPassword}>
              {checkingPassword ? "Проверка…" : "Продолжить"}
            </Button>
          </>
        }
      >
        {passwordRequest && (
          <Field label="Пароль">
            <Input
              ref={passwordInput}
              type="password"
              autoFocus
              autoComplete="current-password"
              disabled={checkingPassword}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void confirmPassword();
                }
              }}
            />
          </Field>
        )}
      </Modal>

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
            <div className="grid grid-cols-1 items-start gap-x-5 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
              {editorColumns.map(({ key, label, type }) => {
                const fieldId = `journal-field-${key}`;
                const value = String(editor.entry[key] ?? "");
                const saving = saveMutation.isPending;
                return (
                  <Fragment key={key}>
                    {key === "departureCondition" && (
                      <h3 className="col-span-full border-b pb-2 text-sm font-semibold">
                        Машина убыла из парка
                      </h3>
                    )}
                    {key === "arrivalDate" && (
                      <h3 className="col-span-full border-b pb-2 text-sm font-semibold">
                        Машина прибыла в парк
                      </h3>
                    )}
                    <div className="min-w-0">
                      <label htmlFor={fieldId} className={`mb-1 ${formLabel}`}>
                        {fieldLabels[key] ?? label}
                      </label>
                      {key === "subdivision" ? (
                        <select
                          id={fieldId}
                          className={formSelect}
                          value={value}
                          disabled={saving || registryLoading || registryFailed}
                          onChange={(event) => changeSubdivision(event.target.value)}
                        >
                          <option value="">
                            {registryFailed ? "Перечень ВВСТ недоступен"
                              : registryLoading ? "Загрузка подразделений…"
                                : "Выберите подразделение"}
                          </option>
                          {subdivisions.map((unit) => <option key={unit}>{unit}</option>)}
                        </select>
                      ) : key === "brand" ? (
                        <select
                          id={fieldId}
                          className={formSelect}
                          value={selectedVehicle?.id ?? ""}
                          disabled={saving || registryLoading || registryFailed || !subdivision || !availableVehicles.length}
                          onChange={(event) => chooseVehicle(event.target.value)}
                        >
                          <option value="" disabled>
                            {value || (registryFailed ? "Перечень ВВСТ недоступен"
                              : registryLoading ? "Загрузка машин…"
                                : !subdivision ? "Сначала выберите подразделение"
                                  : availableVehicles.length ? "Выберите машину из перечня"
                                    : "Нет машин в этом подразделении")}
                          </option>
                          {availableVehicles.map((vehicle) => (
                            <option key={vehicle.id} value={vehicle.id}>
                              {vehicle.brand} — {vehicle.regNumber}
                            </option>
                          ))}
                        </select>
                      ) : key === "returnDeadline" ? (
                        <select
                          id={fieldId}
                          className={formSelect}
                          value={value}
                          disabled={saving}
                          onChange={(event) => changeField(key, event.target.value)}
                        >
                          {returnDeadlines.map((time) => <option key={time}>{time}</option>)}
                        </select>
                      ) : type === "textarea" ? (
                        <textarea
                          id={fieldId}
                          rows={2}
                          className="min-h-[58px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
                          value={value}
                          disabled={saving}
                          onChange={(event) => changeField(key, event.target.value)}
                        />
                      ) : (
                        <Input
                          id={fieldId}
                          type={type ?? "text"}
                          readOnly={key === "regNumber"}
                          value={value}
                          disabled={saving}
                          onChange={(event) => changeField(key, event.target.value)}
                        />
                      )}
                    </div>
                  </Fragment>
                );
              })}
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
          </div>
        )}
      </Modal>
    </section>
  );
}
