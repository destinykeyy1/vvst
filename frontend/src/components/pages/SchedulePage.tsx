import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, Plus, Trash2, Edit, X } from "lucide-react";
import { Button, Field, Input, Modal, PageHeader, Panel, Select } from "@/components/ui-kit";
import { apiGetCollection, apiPutCollection, type ScheduleItem } from "@/lib/api";
import { pickString } from "@/lib/excel";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export type ScheduleKind = "oup" | "household" | "other";

interface SchedulePageProps {
  kind: ScheduleKind;
  title: string;
  subtitle: string;
  collectionName: string;
  columns: {
    name: string;
    location: string;
    brands: string;
    instructor?: string;
    start?: string;
  };
}

const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

const DAYS_OF_WEEK = ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"];

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function getDayOfWeek(year: number, month: number, day: number): number {
  const date = new Date(year, month - 1, day);
  return (date.getDay() + 6) % 7; // Monday = 0
}

function scheduleIsoDate(value: string) {
  const input = value.trim();
  const iso = input.match(/^(\d{4}-\d{2}-\d{2})(?:$|[T ])/);
  const local = input.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  const formatted = iso?.[1] ?? (local
    ? `${local[3].length === 2 ? "20" + local[3] : local[3]}-${local[2].padStart(2, "0")}-${local[1].padStart(2, "0")}`
    : /^\d{5}$/.test(input)
      ? new Date(Date.UTC(1899, 11, 30) + Number(input) * 86400000).toISOString().slice(0, 10)
      : "");
  if (!formatted || formatted.startsWith("0000-")) return null;
  const date = new Date(formatted + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === formatted
    ? formatted : null;
}

function scheduleGridRows(grid: unknown[][], date1904: boolean) {
  const cellText = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ");
  const titles = new Set([
    "вид перевозок", "вид занятия", "название", "наименование", "название мероприятия",
    "наименование мероприятия", "название занятия", "вид мероприятия", "наименование учебной дисциплины",
  ]);
  const headerIndex = grid.findIndex(row => row.some(value => titles.has(cellText(value).toLowerCase())));
  if (headerIndex < 0) {
    throw new Error("Не найден заголовок «Вид перевозок», «Вид занятия» или «Наименование мероприятия».");
  }

  const headers = grid[headerIndex].map(value => {
    if (typeof value === "number" && Number.isInteger(value) && value >= 10000 && value <= 99999) {
      const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
      return new Date(base + value * 86400000).toISOString().slice(0, 10);
    }
    return cellText(value);
  });
  return grid.slice(headerIndex + 1).map(row => {
    const entry: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (!header) return;
      const value = row[index];
      if (typeof value === "number" && value >= 0 && value < 1 &&
          /^(начало|конец|время)/i.test(header)) {
        const minutes = Math.round(value * 1440) % 1440;
        entry[header] = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      } else {
        entry[header] = cellText(value);
      }
    });
    return entry;
  });
}

export function SchedulePage({ kind, title, subtitle, collectionName, columns }: SchedulePageProps) {
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());
  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth());
  const [dayRangeStart, setDayRangeStart] = useState(1);
  const [dayRangeEnd, setDayRangeEnd] = useState(10);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ScheduleItem | null>(null);
  const [formData, setFormData] = useState<Partial<ScheduleItem>>({});
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [deleteTarget, setDeleteTarget] = useState<Set<number> | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importRows, setImportRows] = useState<ScheduleItem[]>([]);
  const [importError, setImportError] = useState("");
  const [importReading, setImportReading] = useState(false);
  const importVersion = useRef(0);
  const importDates = importRows.flatMap(row => row.scheduleDates ?? [row.date]).sort();
  const closeImport = () => {
    importVersion.current++;
    setImportOpen(false);
    setImportFile(null);
    setImportRows([]);
    setImportError("");
    setImportReading(false);
  };
  const queryClient = useQueryClient();

  const { data: items = [], isLoading } = useQuery({
    queryKey: [collectionName],
    queryFn: () => apiGetCollection<ScheduleItem>(collectionName),
  });

  const saveMutation = useMutation({
    mutationFn: async (data: ScheduleItem[]) => {
      return apiPutCollection<ScheduleItem>(collectionName, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [collectionName] });
      setModalOpen(false);
      setEditingItem(null);
      setFormData({});
      toast.success("Сохранено");
    },
    onError: () => {
      toast.error("Ошибка сохранения");
    },
  });

  const handleAdd = () => {
    setEditingItem(null);
    setFormData({
      date: `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-01`,
      title: "",
      location: "",
      requiredBrand: "",
      requiredQuantity: 1,
      startTime: "09:00",
      endTime: "10:00",
      instructor: "",
    });
    setModalOpen(true);
  };

  const handleEdit = (item: ScheduleItem) => {
    setEditingItem(item);
    setFormData(item);
    setModalOpen(true);
  };

  const performDelete = async () => {
    if (!deleteTarget?.size || deleting || saveMutation.isPending) return;
    setDeleting(true);
    try {
      const latest = await apiGetCollection<ScheduleItem>(collectionName);
      const updated = latest.filter(item => !deleteTarget.has(item.id));
      await saveMutation.mutateAsync(updated);
      setSelectedIds(previous => new Set([...previous].filter(id => !deleteTarget.has(id))));
      setDeleteTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось удалить строки");
    } finally {
      setDeleting(false);
    }
  };

  const handleSave = () => {
    if (!formData.title || !formData.location) {
      toast.error("Заполните обязательные поля");
      return;
    }

    const newItem: ScheduleItem = {
      id: editingItem?.id || Date.now(),
      date: formData.date || `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-01`,
      title: formData.title || "",
      location: formData.location || "",
      route: formData.route ?? "",
      requiredBrand: formData.requiredBrand || "",
      requiredQuantity: formData.requiredQuantity || 1,
      startTime: formData.startTime || "09:00",
      endTime: formData.endTime || "10:00",
      instructor: formData.instructor || "",
      teacher: formData.teacher ?? "",
      ...(formData.scheduleRowId ? { scheduleRowId: formData.scheduleRowId } : {}),
      ...(formData.scheduleDates ? { scheduleDates: formData.scheduleDates } : {}),
    };

    let updated: ScheduleItem[];
    if (editingItem) {
      updated = items.map((i) => (i.id === editingItem.id ? newItem : i));
    } else {
      updated = [...items, newItem];
    }

    saveMutation.mutate(updated);
  };

  const readImport = async (file: File) => {
    const version = ++importVersion.current;
    setImportFile(file);
    setImportRows([]);
    setImportError("");
    setImportReading(true);
    try {
      const { read, utils } = await import("xlsx");
      const workbook = read(await file.arrayBuffer(), { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error("Книга Excel не содержит листов.");
      const grid = utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
      const rows = scheduleGridRows(grid, Boolean(workbook.Workbook?.WBProps?.date1904));
      const columnDate = (header: string) => {
        const key = header.trim();
        return /^\d{1,2}$/.test(key)
          ? scheduleIsoDate(monthPrefix + "-" + key.padStart(2, "0"))
          : scheduleIsoDate(key);
      };
      const normalizeTime = (value: string, fallback: string) => {
        if (!value.trim()) return fallback;
        const match = value.trim().match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?$/);
        if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
          throw new Error(`Неверное время «${value}». Используйте 8.00 или 08:00.`);
        }
        return `${match[1].padStart(2, "0")}:${match[2]}`;
      };
      const importedStartId = Date.now();
      const imported: ScheduleItem[] = rows
        .map((row, index): ScheduleItem | null => {
          const discipline = pickString(row, "Наименование учебной дисциплины", "Дисциплина");
          const lessonType = pickString(row, "Вид занятия", "Тип занятия");
          const title = pickString(row, "Название", "Наименование", "Название занятия", "Название мероприятия", "Наименование мероприятия", "Вид перевозок", "Вид мероприятия", "Вид занятия") ||
            (discipline ? `${discipline}${lessonType ? ` (${lessonType})` : ""}` : "");
          const audience = pickString(row, "№ аудитории", "Аудитория", "Кабинет");
          const dept = pickString(row, "Кафедра");
          const group = pickString(row, "Наименование учебной группы", "Учебная группа", "Группа");
          const location =
            pickString(row, "Место", "Локация", "Место проведения", "Место проведения занятия", "Место перевозок") ||
            [audience ? `ауд. ${audience}` : "", dept, group].filter(Boolean).join(", ");
          const brand = pickString(row, "Марка машин", "Марка машины", "Марка", "Машина", columns.brands);
          const quantity = Number.parseInt(pickString(row, "Количество машин", "Количество", "Кол-во"), 10);
          const rawDate = pickString(row, "Дата", "Дата проведения");
          const startTime = pickString(row, "Начало занятий", "Время начала", "Начало", "Время", columns.start ?? "");
          const endTime = pickString(row, "Конец занятий", "Время окончания", "Конец", "Время конца");
          const instructor = pickString(row, "Преподаватель (старший колонны)", "Преподаватель", "Инструктор", "Старший колонны", columns.instructor ?? "");

          if (!title) return null;
          const dates = Object.entries(row).flatMap(([header, value]) => {
            const mark = String(value ?? "").trim();
            if (!mark || /^(?:0+(?:[.,]0+)?|false|нет|[-–—]+)$/i.test(mark)) return [];
            const candidate = columnDate(header);
            return candidate ? [candidate] : [];
          });
          const firstDate = dates[0] ?? scheduleIsoDate(rawDate);
          if (!firstDate && rawDate.trim()) {
            throw new Error(`Строка ${index + 3}: некорректная дата «${rawDate}».`);
          }
          if (!firstDate) return null;

          return {
            id: importedStartId + index,
            date: firstDate,
            title,
            location,
            route: pickString(row, "Маршрут движения", "Маршрут") || (kind === "oup" ? location : group),
            requiredBrand: brand,
            requiredQuantity: Number.isFinite(quantity) && quantity >= 0 ? quantity : 1,
            startTime: normalizeTime(startTime, "09:00"),
            endTime: normalizeTime(endTime, "10:00"),
            instructor,
            teacher: "",
            scheduleDates: dates.length ? dates : [firstDate],
          };
        })
        .filter((item): item is ScheduleItem => item !== null)
        .flatMap((item) => {
          if (kind === "oup") return [item];
          const row = rows[item.id - importedStartId];
          const dates = item.scheduleDates ?? [item.date];
          return dates.map(date => {
            const marked = Object.entries(row ?? {}).find(([header, value]) => {
              return columnDate(header) === date && String(value ?? "").trim();
            })?.[1];
            return { ...item, date, scheduleDates: [date],
              ...(marked == null ? {} : { teacher: String(marked).trim() }) };
          });
        });

      if (version !== importVersion.current) return;
      if (!imported.length) throw new Error("В файле нет строк с мероприятиями и датами");
      setImportRows(imported);
    } catch (error) {
      if (version === importVersion.current) {
        setImportError(error instanceof Error ? error.message : "Не удалось прочитать Excel");
      }
    } finally {
      if (version === importVersion.current) setImportReading(false);
    }
  };

  const confirmImport = async () => {
    if (!importRows.length || saveMutation.isPending || importReading) return;
    try {
      // Match occurrences separately so identical rows in one file keep their multiplicity.
      const signature = (entry: ScheduleItem) => JSON.stringify([
        entry.title.trim(), entry.location.trim(), entry.requiredBrand.trim(),
        entry.instructor.trim(), entry.startTime, entry.endTime,
        [...new Set([entry.date, ...(entry.scheduleDates ?? [])])].sort(),
      ]);
      const positions = new Map<string, number[]>();
      items.forEach((entry, index) => {
        const key = signature(entry);
        const matches = positions.get(key) ?? [];
        matches.push(index);
        positions.set(key, matches);
      });
      const updated = [...items];
      let nextId = items.reduce((max, entry) => Math.max(max, entry.id), Date.now()) + 1;
      for (const entry of importRows) {
        const position = positions.get(signature(entry))?.shift();
        if (position === undefined) {
          updated.push({ ...entry, id: nextId++ });
        } else {
          updated[position] = { ...updated[position], ...entry, id: updated[position].id };
        }
      }
      const normalized = updated.map(entry => {
        const date = scheduleIsoDate(entry.date);
        const dates = entry.scheduleDates?.map(scheduleIsoDate);
        if (!date || dates?.some(value => !value)) {
          throw new Error(`Некорректная дата в записи «${entry.title}» (ID ${entry.id}).`);
        }
        return { ...entry, date, ...(dates ? { scheduleDates: dates.filter((value): value is string => value !== null) } : {}) };
      });
      await saveMutation.mutateAsync(normalized);
      const first = importDates[0];
      if (first) {
        setCurrentYear(Number(first.slice(0, 4)));
        setCurrentMonth(Number(first.slice(5, 7)) - 1);
        setDayRangeStart(1);
        setDayRangeEnd(10);
      }
      closeImport();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Не удалось сохранить расписание.");
    }
  };

  const monthPrefix = currentYear + "-" + String(currentMonth + 1).padStart(2, "0");
  const monthItems = items.filter(item => [item.date, ...(item.scheduleDates ?? [])].some(date => date.startsWith(monthPrefix)));
  const selectedMonthIds = monthItems.filter(item => selectedIds.has(item.id)).map(item => item.id);
  const allSelected = monthItems.length > 0 && selectedMonthIds.length === monthItems.length;

  const daysInMonth = getDaysInMonth(currentYear, currentMonth + 1);
  const dayRangeEndClamped = Math.min(dayRangeEnd, daysInMonth);

  const visibleDays = useMemo(() => {
    const days = [];
    for (let day = dayRangeStart; day <= dayRangeEndClamped; day++) {
      days.push({
        day,
        dayOfWeek: DAYS_OF_WEEK[getDayOfWeek(currentYear, currentMonth + 1, day)],
      });
    }
    return days;
  }, [currentYear, currentMonth, dayRangeStart, dayRangeEndClamped]);

  const prevMonth = () => {
    setSelectedIds(new Set());
    if (currentMonth === 0) {
      setCurrentYear(currentYear - 1);
      setCurrentMonth(11);
    } else {
      setCurrentMonth(currentMonth - 1);
    }
  };

  const nextMonth = () => {
    setSelectedIds(new Set());
    if (currentMonth === 11) {
      setCurrentYear(currentYear + 1);
      setCurrentMonth(0);
    } else {
      setCurrentMonth(currentMonth + 1);
    }
  };

  const prevDayRange = () => {
    const newStart = Math.max(1, dayRangeStart - 10);
    const newEnd = newStart + 9;
    setDayRangeStart(newStart);
    setDayRangeEnd(newEnd);
  };

  const nextDayRange = () => {
    const newEnd = Math.min(daysInMonth, dayRangeEnd + 10);
    const newStart = newEnd - 9;
    setDayRangeStart(newStart);
    setDayRangeEnd(newEnd);
  };

  return (
    <div>
      <PageHeader
        title={title}
        subtitle={`${subtitle}: ${monthItems.length}`}
      />

      <Modal open={importOpen} onClose={() => { if (!saveMutation.isPending) closeImport(); }}
        title="Импорт из Excel" eyebrow="Расписание" size="md"
        footer={<>
          <Button variant="outline" disabled={saveMutation.isPending} onClick={closeImport}>Отмена</Button>
          <Button disabled={importReading || saveMutation.isPending || !importRows.length} onClick={confirmImport}>
            Импортировать ({importRows.length})
          </Button>
        </>}>
        <div className="space-y-5">
          <div className="space-y-2 rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700">
            <div className="text-xs uppercase tracking-wider text-neutral-500">Формат файла</div>
            <p>Используйте шаблон расписания. Заголовки находятся во второй строке. Первые восемь столбцов содержат сведения о мероприятии, дальше идут даты. Заполненная ячейка под датой задаёт день мероприятия.</p>
            {kind !== "oup" && <p className="text-xs">Название берётся из «Вид перевозок», место — из «Место перевозок». Отметка под датой сохраняется вместе с записью. Время можно указать как 8.00 или 08:00.</p>}
            {kind !== "oup" && <a href="/schedule-import-template.xlsx" download className="text-xs underline">Скачать шаблон Excel</a>}
          </div>
          <label className="block">
            <span className="mb-2 block text-xs uppercase tracking-wider text-neutral-500">Выбор файла</span>
            <span className="relative block rounded-md border border-dashed border-neutral-300 px-4 py-3 text-center text-sm hover:bg-neutral-50 focus-within:ring-2">
              {importFile ? `Выбран файл: ${importFile.name}` : "Выберите файл Excel (.xlsx)"}
              <input type="file" accept=".xlsx,.xls" disabled={saveMutation.isPending}
                className="absolute inset-0 w-full cursor-pointer opacity-0" onChange={event => {
                  const file = event.target.files?.[0];
                  if (file) void readImport(file);
                  event.target.value = "";
                }} />
            </span>
          </label>
          {importReading && <p role="status" className="text-sm text-neutral-500">Чтение файла…</p>}
          {importError && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">{importError}</p>}
          {!!importRows.length && <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
            <p>Готово к импорту: {importRows.length}</p>
            <p className="mt-1 text-xs">Период: {[importDates[0], importDates[importDates.length - 1]]
              .map(value => value.split("-").reverse().join(".")).join(" — ")}</p>
          </div>}
        </div>
      </Modal>

      <Panel className="mb-4 flex flex-col items-end gap-2 rounded-lg p-3">
        <div className="flex flex-wrap gap-2">
            <Button variant="danger" disabled={!selectedMonthIds.length || deleting || saveMutation.isPending}
              onClick={() => setDeleteTarget(new Set(selectedMonthIds))}>
              <Trash2 className="mr-2 h-4 w-4" />
              Удалить выбранные ({selectedMonthIds.length})
            </Button>
            <Button variant="outline" onClick={() => { closeImport(); setImportOpen(true); }}>
              Импорт Excel
            </Button>
            <Button onClick={handleAdd}>
              <Plus className="mr-2 h-4 w-4" />
              {kind === "oup" ? "Добавить занятие" : "Добавить мероприятие"}
            </Button>
          </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">МЕСЯЦ</span>
          <Button variant="outline" size="icon" onClick={prevMonth}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[160px] text-center text-sm">
            {MONTHS[currentMonth]} {currentYear} Г.
          </span>
          <Button variant="outline" size="icon" onClick={nextMonth}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={prevDayRange}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[100px] text-center text-sm">
            Дни {dayRangeStart}-{dayRangeEndClamped}
          </span>
          <Button variant="outline" size="icon" onClick={nextDayRange}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </Panel>

      <Panel className="thin-scroll min-h-[calc(100vh-19rem)] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-neutral-50 text-[10px] uppercase text-neutral-500 [&_th]:font-normal">
            <tr className="border-b border-border">
              <th className="w-12 px-3 py-3">
                <input type="checkbox" aria-label="Выбрать все строки за месяц"
                  checked={allSelected} disabled={!monthItems.length || deleting || saveMutation.isPending}
                  ref={element => { if (element) element.indeterminate = !allSelected && selectedMonthIds.length > 0; }}
                  onChange={event => setSelectedIds(new Set(event.target.checked ? monthItems.map(item => item.id) : []))} />
              </th>
              <th className="px-3 py-3 text-left">{columns.name}</th>
              <th className="px-3 py-3 text-left">МЕСТО</th>
              <th className="px-3 py-3 text-left">{columns.brands}</th>
              {columns.instructor && <th className="px-3 py-3 text-left">{columns.instructor}</th>}
              {columns.start && <th className="px-3 py-3 text-left">{columns.start}</th>}
              {visibleDays.map(({ day, dayOfWeek }) => (
                <th key={day} className="px-2 py-3 text-center min-w-[40px]">
                  <div className="text-xs text-muted-foreground">{String(day).padStart(2, "0")}</div>
                  <div className="text-[10px] text-muted-foreground">{dayOfWeek}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {monthItems.length === 0 ? (
              <tr>
                <td colSpan={4 + (columns.instructor ? 1 : 0) + (columns.start ? 1 : 0) + visibleDays.length} className="py-20 text-center text-muted-foreground">
                  {kind === "oup" ? "В этом месяце занятий нет" : "В этом месяце мероприятий нет"}
                </td>
              </tr>
            ) : (
              monthItems.map((item) => (
                <tr key={item.id} className={cn("border-b border-border", selectedIds.has(item.id) && "bg-accent")}>
                  <td className="px-3 py-3 text-center">
                    <input type="checkbox" aria-label={`Выбрать ${item.title}`}
                      checked={selectedIds.has(item.id)} disabled={deleting || saveMutation.isPending}
                      onChange={event => {
                        const checked = event.target.checked;
                        setSelectedIds(previous => {
                          const next = new Set(previous);
                          if (checked) next.add(item.id);
                          else next.delete(item.id);
                          return next;
                        });
                      }} />
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span>{item.title}</span>
                      <div className="flex gap-1">
                        <button
                          className="no-print text-muted-foreground hover:text-foreground"
                          onClick={() => handleEdit(item)}
                        >
                          <Edit className="h-4 w-4" />
                        </button>
                        <button
                          className="no-print text-muted-foreground hover:text-destructive"
                          disabled={deleting || saveMutation.isPending}
                          onClick={() => setDeleteTarget(new Set([item.id]))}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3">{item.location}</td>
                  <td className="px-3 py-3">
                    {item.requiredBrand} ({item.requiredQuantity})
                  </td>
                  {columns.instructor && <td className="px-3 py-3">{item.instructor}</td>}
                  {columns.start && <td className="px-3 py-3">{item.startTime}</td>}
                  {visibleDays.map(({ day }) => (
                    <td key={day} className="px-2 py-3 text-center">
                      {[item.date, ...(item.scheduleDates ?? [])].includes(monthPrefix + "-" + String(day).padStart(2, "0")) ? "✓" : ""}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingItem ? "Редактировать" : kind === "oup" ? "Добавить занятие" : "Добавить мероприятие"}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              Отмена
            </Button>
            <Button onClick={handleSave} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Сохранение..." : "Сохранить"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Название">
            <Input
              value={formData.title || ""}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              placeholder={kind === "oup" ? "Название занятия" : "Название мероприятия"}
            />
          </Field>
          <Field label="Место">
            <Input
              value={formData.location || ""}
              onChange={(e) => setFormData({ ...formData, location: e.target.value })}
              placeholder="Место проведения"
            />
          </Field>
          <Field label="Марка машины">
            <Input
              value={formData.requiredBrand || ""}
              onChange={(e) => setFormData({ ...formData, requiredBrand: e.target.value })}
              placeholder="Например: КАМАЗ-43501"
            />
          </Field>
          <Field label="Количество">
            <Input
              type="number"
              value={formData.requiredQuantity || 1}
              onChange={(e) => setFormData({ ...formData, requiredQuantity: parseInt(e.target.value) || 1 })}
              min="1"
            />
          </Field>
          <Field label="Дата">
            <Input
              type="date"
              value={formData.date || ""}
              onChange={(e) => setFormData({ ...formData, date: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Время начала">
              <Input
                type="time"
                value={formData.startTime || ""}
                onChange={(e) => setFormData({ ...formData, startTime: e.target.value })}
              />
            </Field>
            <Field label="Время окончания">
              <Input
                type="time"
                value={formData.endTime || ""}
                onChange={(e) => setFormData({ ...formData, endTime: e.target.value })}
              />
            </Field>
          </div>
          {columns.instructor && (
            <Field label={columns.instructor}>
              <Input
                value={formData.instructor || ""}
                onChange={(e) => setFormData({ ...formData, instructor: e.target.value })}
                placeholder="ФИО преподавателя"
              />
            </Field>
          )}
          {columns.start && (
            <Field label="Начало">
              <Input
                value={formData.startTime || ""}
                onChange={(e) => setFormData({ ...formData, startTime: e.target.value })}
                placeholder="Время начала"
              />
            </Field>
          )}
        </div>
      </Modal>

      <Modal
        open={deleteTarget !== null}
        onClose={() => { if (!deleting) setDeleteTarget(null); }}
        title="Подтверждение удаления"
        size="sm"
        footer={
          <>
            <Button variant="outline" disabled={deleting} onClick={() => setDeleteTarget(null)}>
              Отмена
            </Button>
            <Button variant="danger" disabled={deleting || saveMutation.isPending} onClick={performDelete}>
              Удалить
            </Button>
          </>
        }
      >
        <p className="text-sm">Будет удалено строк: {deleteTarget?.size ?? 0}.</p>
      </Modal>
    </div>
  );
}
