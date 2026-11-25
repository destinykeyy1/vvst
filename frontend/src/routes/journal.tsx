import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Edit, Trash2 } from "lucide-react";
import { Button, Field, Input, Modal, PageHeader, Panel, Select } from "@/components/ui-kit";
import { apiGetCollection, apiPutCollection } from "@/lib/api";
import { useState } from "react";
import { toast } from "sonner";
import type { JournalRow } from "@/lib/types";

export const Route = createFileRoute("/journal")({
  component: JournalPage,
});

function JournalPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<JournalRow | null>(null);
  const [formData, setFormData] = useState<Partial<JournalRow>>({});

  const queryClient = useQueryClient();

  const { data: journal = [], isLoading } = useQuery({
    queryKey: ["journal"],
    queryFn: () => apiGetCollection<JournalRow>("journal"),
  });

  const saveMutation = useMutation({
    mutationFn: async (data: JournalRow[]) => {
      return apiPutCollection("journal", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["journal"] });
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
      id: crypto.randomUUID(),
      date: new Date().toISOString().split("T")[0],
      unit: "",
      driver: "",
      waybill: "",
      brand: "",
      plate: "",
      techState: "",
      speedometer: "",
      odometerOut: "",
      departTime: "",
      odometerIn: "",
      returnTime: "",
      dutyOfficer: "",
    });
    setModalOpen(true);
  };

  const handleEdit = (item: JournalRow) => {
    setEditingItem(item);
    setFormData(item);
    setModalOpen(true);
  };

  const handleDelete = (id: string) => {
    if (!window.confirm("Удалить запись?")) return;
    const updated = journal.filter((j) => j.id !== id);
    saveMutation.mutate(updated);
  };

  const handleSave = () => {
    if (!formData.date || !formData.plate) {
      toast.error("Заполните обязательные поля (дата, гос. номер)");
      return;
    }

    const newItem: JournalRow = {
      id: editingItem?.id || crypto.randomUUID(),
      date: formData.date || "",
      unit: formData.unit || "",
      driver: formData.driver || "",
      waybill: formData.waybill || "",
      brand: formData.brand || "",
      plate: formData.plate || "",
      techState: formData.techState || "",
      speedometer: formData.speedometer || "",
      odometerOut: formData.odometerOut || "",
      departTime: formData.departTime || "",
      odometerIn: formData.odometerIn || "",
      returnTime: formData.returnTime || "",
      dutyOfficer: formData.dutyOfficer || "",
    };

    let updated: JournalRow[];
    if (editingItem) {
      updated = journal.map((j) => (j.id === editingItem.id ? newItem : j));
    } else {
      updated = [...journal, newItem];
    }

    saveMutation.mutate(updated);
  };

  return (
    <div>
      <PageHeader
        title="Журнал"
        subtitle={`Всего записей: ${journal.length}`}
        actions={
          <Button onClick={handleAdd}>
            <Plus className="mr-2 h-4 w-4" />
            Добавить запись
          </Button>
        }
      />

      <Panel className="thin-scroll max-h-[calc(100vh-20rem)] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr className="border-b border-border">
              <th className="px-3 py-3 text-left">Дата</th>
              <th className="px-3 py-3 text-left">Подразделение</th>
              <th className="px-3 py-3 text-left">Водитель</th>
              <th className="px-3 py-3 text-left">Наряд</th>
              <th className="px-3 py-3 text-left">Марка</th>
              <th className="px-3 py-3 text-left">Гос. номер</th>
              <th className="px-3 py-3 text-left">Тех. состояние</th>
              <th className="w-24 px-3 py-3 text-center">Действия</th>
            </tr>
          </thead>
          <tbody>
            {journal.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-20 text-center text-muted-foreground">
                  Записей в журнале нет
                </td>
              </tr>
            ) : (
              journal
                .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                .map((item) => (
                  <tr key={item.id} className="border-b border-border">
                    <td className="px-3 py-3">{item.date}</td>
                    <td className="px-3 py-3">{item.unit}</td>
                    <td className="px-3 py-3">{item.driver}</td>
                    <td className="px-3 py-3">{item.waybill}</td>
                    <td className="px-3 py-3">{item.brand}</td>
                    <td className="px-3 py-3">{item.plate}</td>
                    <td className="px-3 py-3">{item.techState}</td>
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
        title={editingItem ? "Редактировать запись" : "Добавить запись"}
        size="lg"
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
        <div className="grid grid-cols-2 gap-4">
          <Field label="Дата">
            <Input
              type="date"
              value={formData.date || ""}
              onChange={(e) => setFormData({ ...formData, date: e.target.value })}
            />
          </Field>
          <Field label="Подразделение">
            <Input
              value={formData.unit || ""}
              onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
            />
          </Field>
          <Field label="Водитель">
            <Input
              value={formData.driver || ""}
              onChange={(e) => setFormData({ ...formData, driver: e.target.value })}
            />
          </Field>
          <Field label="Наряд">
            <Input
              value={formData.waybill || ""}
              onChange={(e) => setFormData({ ...formData, waybill: e.target.value })}
            />
          </Field>
          <Field label="Марка">
            <Input
              value={formData.brand || ""}
              onChange={(e) => setFormData({ ...formData, brand: e.target.value })}
            />
          </Field>
          <Field label="Гос. номер">
            <Input
              value={formData.plate || ""}
              onChange={(e) => setFormData({ ...formData, plate: e.target.value })}
            />
          </Field>
          <Field label="Тех. состояние">
            <Input
              value={formData.techState || ""}
              onChange={(e) => setFormData({ ...formData, techState: e.target.value })}
            />
          </Field>
          <Field label="Спидометр">
            <Input
              value={formData.speedometer || ""}
              onChange={(e) => setFormData({ ...formData, speedometer: e.target.value })}
            />
          </Field>
          <Field label="Одометр (выезд)">
            <Input
              value={formData.odometerOut || ""}
              onChange={(e) => setFormData({ ...formData, odometerOut: e.target.value })}
            />
          </Field>
          <Field label="Время выезда">
            <Input
              type="time"
              value={formData.departTime || ""}
              onChange={(e) => setFormData({ ...formData, departTime: e.target.value })}
            />
          </Field>
          <Field label="Одометр (возврат)">
            <Input
              value={formData.odometerIn || ""}
              onChange={(e) => setFormData({ ...formData, odometerIn: e.target.value })}
            />
          </Field>
          <Field label="Время возврата">
            <Input
              type="time"
              value={formData.returnTime || ""}
              onChange={(e) => setFormData({ ...formData, returnTime: e.target.value })}
            />
          </Field>
          <Field label="Дежурный офицер" className="col-span-2">
            <Input
              value={formData.dutyOfficer || ""}
              onChange={(e) => setFormData({ ...formData, dutyOfficer: e.target.value })}
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}