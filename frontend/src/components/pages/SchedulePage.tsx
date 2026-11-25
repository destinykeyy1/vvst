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
  const [currentYear, setCurrentYear] = useState(2026);
  const [currentMonth, setCurrentMonth] = useState(8); // September (0-indexed)
  const [dayRangeStart, setDayRangeStart] = useState(1);
  const [dayRangeEnd, setDayRangeEnd] = useState(10);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ScheduleItem | null>(null);
  const [formData, setFormData] = useState<Partial<ScheduleItem>>({});
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);

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
      route: formData.route,
      requiredBrand: formData.requiredBrand || "",
      requiredQuantity: formData.requiredQuantity || 1,
      startTime: formData.startTime || "09:00",
      endTime: formData.endTime || "10:00",
      instructor: formData.instructor || "",
      teacher: formData.teacher,
      scheduleRowId: formData.scheduleRowId,
      scheduleDates: formData.scheduleDates,
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
      const imported: ScheduleItem[] = rows
        .map((row, index) => {
          const title = pickString(row, "Название", "Наименование", "Название занятия", "Название мероприятия");
          const location = pickString(row, "Место", "Локация", "Место проведения");
          const brand = pickString(row, "Марка", "Марка машины", "Машина");
          const quantity = parseInt(pickString(row, "Количество", "Кол-во", "Количество машин")) || 1;
          const date = pickString(row, "Дата", "Дата проведения");
          const startTime = pickString(row, "Время начала", "Начало", "Время");
          const endTime = pickString(row, "Время окончания", "Конец", "Время конца");
          const instructor = pickString(row, "Преподаватель", "Инструктор", "Старший колонны");

          if (!title || !location) return null;

          return {
            id: Date.now() + index,
            date: date || `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-01`,
            title,
            location,
            route: "",
            requiredBrand: brand,
            requiredQuantity: quantity,
            startTime: startTime || "09:00",
            endTime: endTime || "10:00",
            instructor,
            teacher: "",
            scheduleRowId: undefined,
            scheduleDates: undefined,
          };
        })
        .filter((item): item is ScheduleItem => item !== null);

      if (imported.length === 0) {
        toast.error("В файле не найдено корректных записей");
        return;
      }

      const updated = [...items, ...imported];
      saveMutation.mutate(updated);
    } catch (error) {
      toast.error("Ошибка при чтении файла Excel");
      console.error(error);
    }
  };

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
        subtitle={`${subtitle}: ${items.length}`}
        actions={
          <>
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
                if (file) {
                  handleExcelImport(file);
                  e.target.value = "";
                }
              }}
            />
            <Button onClick={handleAdd}>
              <Plus className="mr-2 h-4 w-4" />
              {kind === "oup" ? "Добавить занятие" : "Добавить мероприятие"}
            </Button>
          </>
        }
      />

      <Panel className="mb-4 flex flex-wrap items-center gap-4 p-3">
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

      <Panel className="thin-scroll max-h-[calc(100vh-20rem)] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-muted">
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
            {items.length === 0 ? (
              <tr>
                <td colSpan={4 + (columns.instructor ? 1 : 0) + (columns.start ? 1 : 0) + visibleDays.length} className="py-20 text-center text-muted-foreground">
                  {kind === "oup" ? "В этом месяце занятий нет" : "В этом месяце мероприятий нет"}
                </td>
              </tr>
            ) : (
              items.map((item) => (
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
                      {/* Here you would check if the schedule has this date */}
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
