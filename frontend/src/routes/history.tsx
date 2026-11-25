import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus, Edit, Trash2 } from "lucide-react";
import { Button, Field, Input, Modal, PageHeader, Panel } from "@/components/ui-kit";
import { apiGetCollection, apiPutCollection } from "@/lib/api";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

interface HistoryItem {
  id: number;
  vehicleId: number;
  date: string;
  description: string;
}

export const Route = createFileRoute("/history")({
  component: HistoryPage,
});

function HistoryPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<HistoryItem | null>(null);
  const [formData, setFormData] = useState<Partial<HistoryItem>>({});
  const [selectedVehicleId, setSelectedVehicleId] = useState<number | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; vehicleId: number } | null>(null);

  const queryClient = useQueryClient();

  const { data: history = [] } = useQuery({
    queryKey: ["vehicle-details"],
    queryFn: () => apiGetCollection<any>("vehicle-details"),
  });

  const allHistory = (history || []).flatMap((v: any) =>
    (v.history || []).map((h: HistoryItem) => ({ ...h, vehicleId: v.vehicleId }))
  );

  const saveMutation = useMutation({
    mutationFn: async (updatedVehicles: any[]) => {
      return apiPutCollection("vehicle-details", updatedVehicles);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vehicle-details"] });
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
      date: new Date().toISOString().split("T")[0],
      description: "",
    });
    setModalOpen(true);
  };

  const handleEdit = (item: HistoryItem) => {
    setEditingItem(item);
    setFormData(item);
    setModalOpen(true);
  };

  const handleDelete = (id: number, vehicleId: number) => {
    setDeleteTarget({ id, vehicleId });
    setDeleteOpen(true);
  };

  const performDelete = () => {
    if (!deleteTarget) return;
    const updatedVehicles = history.map((v: any) => {
      if (v.vehicleId !== deleteTarget.vehicleId) return v;
      return {
        ...v,
        history: (v.history || []).filter((h: HistoryItem) => h.id !== deleteTarget.id),
      };
    });
    saveMutation.mutate(updatedVehicles);
    setDeleteOpen(false);
    setDeleteTarget(null);
  };

  const handleSave = () => {
    if (!formData.date || !formData.description) {
      toast.error("Заполните обязательные поля");
      return;
    }

    const newItem: HistoryItem = {
      id: editingItem?.id || Date.now(),
      vehicleId: editingItem?.vehicleId || selectedVehicleId || 1,
      date: formData.date,
      description: formData.description,
    };

    const updatedVehicles = history.map((v: any) => {
      if (editingItem && v.vehicleId === editingItem.vehicleId) {
        return {
          ...v,
          history: (v.history || []).map((h: HistoryItem) =>
            h.id === editingItem.id ? newItem : h
          ),
        };
      }
      if (!editingItem && v.vehicleId === (selectedVehicleId || 1)) {
        return {
          ...v,
          history: [...(v.history || []), newItem],
        };
      }
      return v;
    });

    saveMutation.mutate(updatedVehicles);
  };

  return (
    <div>
      <PageHeader
        title="История эксплуатации"
        subtitle={`Всего записей: ${allHistory.length}`}
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
              <th className="px-3 py-3 text-left">ID машины</th>
              <th className="px-3 py-3 text-left">Описание</th>
              <th className="w-24 px-3 py-3 text-center">Действия</th>
            </tr>
          </thead>
          <tbody>
            {allHistory.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-20 text-center text-muted-foreground">
                  Записей истории нет
                </td>
              </tr>
            ) : (
              allHistory
                .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                .map((item) => (
                  <tr key={`${item.vehicleId}-${item.id}`} className="border-b border-border">
                    <td className="px-3 py-3">{item.date}</td>
                    <td className="px-3 py-3">{item.vehicleId}</td>
                    <td className="px-3 py-3">{item.description}</td>
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
                          onClick={() => handleDelete(item.id, item.vehicleId)}
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
          <Field label="ID машины">
            <Input
              type="number"
              value={formData.vehicleId || selectedVehicleId || ""}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                setFormData({ ...formData, vehicleId: val });
                setSelectedVehicleId(val);
              }}
              placeholder="ID машины"
            />
          </Field>
          <Field label="Дата">
            <Input
              type="date"
              value={formData.date || ""}
              onChange={(e) => setFormData({ ...formData, date: e.target.value })}
            />
          </Field>
          <Field label="Описание">
            <textarea
              className="h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/30"
              value={formData.description || ""}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Описание события"
            />
          </Field>
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