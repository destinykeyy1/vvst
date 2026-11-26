import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, Plus, Trash2, Edit, X } from "lucide-react";
import { Button, Field, Input, Modal, PageHeader, Panel, Select } from "@/components/ui-kit";
import { apiGetCollection, apiPutCollection, type ScheduleItem } from "@/lib/api";
import { readExcelRows, pickString } from "@/lib/excel";
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

export function SchedulePage({ kind, title, subtitle, collectionName, columns }: SchedulePageProps) {
  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());
  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth());
  const [dayRangeStart, setDayRangeStart] = useState(1);
  const [dayRangeEnd, setDayRangeEnd] = useState(10);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ScheduleItem | null>(null);
  const [formData, setFormData] = useState<Partial<ScheduleItem>>({});
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);

  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
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

  const handleDelete = (id: number) => {
    setDeleteTarget(id);
    setDeleteOpen(true);
  };

  const performDelete = () => {
    if (deleteTarget === null) return;
    const updated = items.filter((i) => i.id !== deleteTarget);
    saveMutation.mutate(updated);
    setDeleteOpen(false);
    setDeleteTarget(null);
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

  const handleExcelImport = async (file: File) => {
    try {
      const rows = await readExcelRows(file);
      const toIso = (d: string) => {
        const iso = d.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|[T ])/);
        if (iso) return iso[1];
        const m = d.trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
        if (!m?.[1] || !m[2] || !m[3]) return d;
        const y = m[3].length === 2 ? `20${m[3]}` : m[3];
        return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
      };
      const imported: ScheduleItem[] = rows
        .map((row, index): ScheduleItem | null => {
          const discipline = pickString(row, "Наименование учебной дисциплины", "Дисциплина");
          const lessonType = pickString(row, "Вид занятия", "Тип занятия");
          const title = pickString(row, "Название", "Наименование", "Название занятия", "Название мероприятия", "Вид перевозок", "Вид мероприятия", "Вид занятия") ||
            (discipline ? `${discipline}${lessonType ? ` (${lessonType})` : ""}` : "");
          const audience = pickString(row, "№ аудитории", "Аудитория", "Кабинет");
          const dept = pickString(row, "Кафедра");
          const group = pickString(row, "Наименование учебной группы", "Учебная группа", "Группа");
          const location =
            pickString(row, "Место", "Локация", "Место проведения", "Место проведения занятия", "Место перевозок") ||
            [audience ? `ауд. ${audience}` : "", dept, group].filter(Boolean).join(", ");
          const brand = pickString(row, "Марка машин", "Марка машины", "Марка", "Машина", columns.brands);
          const quantity = Number.parseInt(pickString(row, "Количество машин", "Количество", "Кол-во"), 10);
          const date = toIso(pickString(row, "Дата", "Дата проведения"));
          const startTime = pickString(row, "Начало занятий", "Время начала", "Начало", "Время", columns.start ?? "");
          const endTime = pickString(row, "Конец занятий", "Время окончания", "Конец", "Время конца");
          const instructor = pickString(row, "Преподаватель (старший колонны)", "Преподаватель", "Инструктор", "Старший колонны", columns.instructor ?? "");

          if (!title) return null;
          const dates = Object.entries(row).flatMap(([header, value]) => {
            const mark = String(value ?? "").trim();
            if (!mark || /^(?:0+(?:[.,]0+)?|false|нет|[-–—]+)$/i.test(mark)) return [];
            const key = header.trim();
            const candidate = /^\d{1,2}$/.test(key) && Number(key) >= 1 && Number(key) <= daysInMonth
              ? monthPrefix + "-" + key.padStart(2, "0") : toIso(key);
            return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? [candidate] : [];
          });
          const firstDate = dates[0] ?? date;
          if (!firstDate) return null;

          return {
            id: Date.now() + index,
            date: firstDate,
            title,
            location,
            route: pickString(row, "Маршрут движения", "Маршрут") || (kind === "oup" ? location : group),
            requiredBrand: brand,
            requiredQuantity: Number.isFinite(quantity) && quantity >= 0 ? quantity : 1,
            startTime: startTime || "09:00",
            endTime: endTime || "10:00",
            instructor,
            teacher: "",
            scheduleDates: dates.length ? dates : [firstDate],
          };
        })
        .filter((item): item is ScheduleItem => item !== null);

      if (imported.length === 0) {
        toast.error("В файле не найдено корректных записей");
        return;
      }

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
      for (const entry of imported) {
        const position = positions.get(signature(entry))?.shift();
        if (position === undefined) {
          updated.push({ ...entry, id: nextId++ });
        } else {
          updated[position] = { ...updated[position], ...entry, id: updated[position].id };
        }
      }
      saveMutation.mutate(updated);
    } catch (error) {
      toast.error("Ошибка при чтении файла Excel");
      console.error(error);
    }
  };

  const monthPrefix = currentYear + "-" + String(currentMonth + 1).padStart(2, "0");
  const monthItems = items.filter(item => [item.date, ...(item.scheduleDates ?? [])].some(date => date.startsWith(monthPrefix)));
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
    if (currentMonth === 0) {
      setCurrentYear(currentYear - 1);
      setCurrentMonth(11);
    } else {
      setCurrentMonth(currentMonth - 1);
    }
  };

  const nextMonth = () => {
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

      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="Импорт из Excel" eyebrow="Расписание"
        footer={<><Button variant="outline" onClick={() => setImportOpen(false)}>Отмена</Button>
          <Button disabled={!importFile} onClick={() => { if (importFile) { setImportOpen(false); void handleExcelImport(importFile); } }}>{importFile ? "Импортировать" : "Импортировать (0)"}</Button></>}>
        <div className="space-y-5">
          <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4">
            <div className="mb-2 text-xs uppercase tracking-wider text-neutral-500">Формат файла</div>
            <p className="text-sm text-neutral-700">Выберите таблицу Excel с записями расписания.</p>
          </div>
          <label className="block"><span className="mb-2 block text-xs uppercase tracking-wider text-neutral-500">Выбор файла</span>
            <span className="relative block rounded-md border border-dashed border-neutral-300 bg-white px-4 py-3 text-center text-sm text-neutral-700 hover:bg-neutral-50 focus-within:ring-2">
              {importFile ? "Заменить файл Excel" : "Выберите файл Excel (.xlsx)"}
              <input type="file" accept=".xlsx,.xls" className="absolute inset-0 w-full cursor-pointer opacity-0" onChange={e => setImportFile(e.target.files?.[0] ?? null)} />
            </span>
          </label>
        </div>
      </Modal>

      <Panel className="mb-4 flex flex-col items-end gap-2 rounded-lg p-3">
        <div className="flex gap-2">
            <Button variant="outline" onClick={() => { setImportFile(null); setImportOpen(true); }}>
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
                <input type="checkbox" aria-label="Выбрать все" />
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
                <tr key={item.id} className="border-b border-border">
                  <td className="px-3 py-3 text-center">
                    <input type="checkbox" aria-label={`Выбрать ${item.title}`} />
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
                          onClick={() => handleDelete(item.id)}
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
        <p className="text-sm">Вы уверены, что хотите удалить эту запись? Это действие нельзя отменить.</p>
      </Modal>
    </div>
  );
}
