import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Edit, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Field, Input, Modal, PageHeader, Panel } from "@/components/ui-kit";
import { apiGetCollection, apiPutCollection } from "@/lib/api";
import { useState } from "react";
import { toast } from "sonner";

interface JournalDuty {
  id: number;
  date: string;
  name: string;
}

export const Route = createFileRoute("/duty")({
  component: DutyPage,
});

function DutyPage() {
  const [currentYear, setCurrentYear] = useState(2026);
  const [currentMonth, setCurrentMonth] = useState(8); // September (0-indexed)
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<JournalDuty | null>(null);
  const [formData, setFormData] = useState<Partial<JournalDuty>>({});

  const queryClient = useQueryClient();

  const { data: duties = [], isLoading } = useQuery({
    queryKey: ["journal-duty"],
    queryFn: () => apiGetCollection<JournalDuty>("journal-duty"),
  });

  const saveMutation = useMutation({
    mutationFn: async (data: JournalDuty[]) => {
      return apiPutCollection("journal-duty", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["journal-duty"] });
      setModalOpen(false);
      setEditingItem(null);
      setFormData({});
      toast.success("Сохранено");
    },
    onError: () => {
      toast.error("Ошибка сохранения");
    },
  });

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

  const MONTHS = [
    "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
  ];

  const filteredDuties = duties.filter((d) => {
    const date = new Date(d.date);
    return date.getFullYear() === currentYear && date.getMonth() === currentMonth;
  });

  const handleAdd = () => {
    setEditingItem(null);
    setFormData({
      date: `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-01`,
      name: "",
    });
    setModalOpen(true);
  };

  const handleEdit = (item: JournalDuty) => {
    setEditingItem(item);
    setFormData(item);
    setModalOpen(true);
  };

  const handleDelete = (id: number) => {
    if (!window.confirm("Удалить запись?")) return;
    const updated = duties.filter((d) => d.id !== id);
    saveMutation.mutate(updated);
  };

  const handleSave = () => {
    if (!formData.date || !formData.name) {
      toast.error("Заполните обязательные поля");
      return;
    }

    const newItem: JournalDuty = {
      id: editingItem?.id || Date.now(),
      date: formData.date,
      name: formData.name,
    };

    let updated: JournalDuty[];
    if (editingItem) {
      updated = duties.map((d) => (d.id === editingItem.id ? newItem : d));
    } else {
      updated = [...duties, newItem];
    }

    saveMutation.mutate(updated);
  };

  return (
    <div>
      <PageHeader
        title="Дежурный по парку"
        subtitle={`${MONTHS[currentMonth]} ${currentYear}`}
        actions={
          <Button onClick={handleAdd}>
            <Plus className="mr-2 h-4 w-4" />
            Добавить дежурство
          </Button>
        }
      />

      <Panel className="mb-4 flex items-center gap-2 p-3">
        <Button variant="outline" size="icon" onClick={prevMonth}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-[160px] text-center text-sm">
          {MONTHS[currentMonth]} {currentYear}
        </span>
        <Button variant="outline" size="icon" onClick={nextMonth}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </Panel>

      <Panel className="thin-scroll max-h-[calc(100vh-20rem)] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr className="border-b border-border">
              <th className="px-3 py-3 text-left">Дата</th>
              <th className="px-3 py-3 text-left">Дежурный</th>
              <th className="w-24 px-3 py-3 text-center">Действия</th>
            </tr>
          </thead>
          <tbody>
            {filteredDuties.length === 0 ? (
              <tr>
                <td colSpan={3} className="py-20 text-center text-muted-foreground">
                  В этом месяце дежурств нет
                </td>
              </tr>
            ) : (
              filteredDuties
                .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
                .map((item) => (
                  <tr key={item.id} className="border-b border-border">
                    <td className="px-3 py-3">{item.date}</td>
                    <td className="px-3 py-3">{item.name}</td>
                    <td className="px-3 py-3 text-center">
                      <div className="flex justify-center gap-2">
                        <button
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => handleEdit(item)}
                        >
                          <Edit className="h-4 w-4" />
                        </button>
                        <button
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => handleDelete(item.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
            )}
          </tbody>
        </table>
      </Panel>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingItem ? "Редактировать дежурство" : "Добавить дежурство"}
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
          <Field label="Дата">
            <Input
              type="date"
              value={formData.date || ""}
              onChange={(e) => setFormData({ ...formData, date: e.target.value })}
            />
          </Field>
          <Field label="Дежурный">
            <Input
              value={formData.name || ""}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="ФИО дежурного"
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}