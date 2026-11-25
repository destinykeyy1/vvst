import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Edit, Trash2 } from "lucide-react";
import { Button, Field, Input, Modal, PageHeader, Panel } from "@/components/ui-kit";
import { apiGetCollection, apiPutCollection } from "@/lib/api";
import { useState } from "react";
import { toast } from "sonner";
import type { JournalEntry } from "@/lib/types";

export const Route = createFileRoute("/journal")({
  component: JournalPage,
});

// UI model keeps the original journal layout; it is adapted to JournalEntryDTO on save/load.
type JournalForm = {
  id: number;
  date: string;
  unit: string;
  driver: string;
  waybill: string;
  brand: string;
  plate: string;
  techState: string;
  speedometer: string;
  odometerOut: string;
  departTime: string;
  odometerIn: string;
  returnTime: string;
  dutyOfficer: string;
};

const EMPTY_FORM: JournalForm = {
  id: 0,
  date: "",
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
};

const toIntOrNull = (v: string) => {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
};

function entryToForm(e: JournalEntry): JournalForm {
  return {
    id: e.id,
    date: e.date,
    unit: e.subdivision,
    driver: e.driver,
    waybill: e.waybillNumber,
    brand: e.brand,
    plate: e.regNumber,
    techState: e.departureCondition,
    speedometer: e.speedometer ?? "",
    odometerOut: e.departureOdometer === null || e.departureOdometer === undefined ? "" : String(e.departureOdometer),
    departTime: e.departureTime,
    odometerIn: e.arrivalOdometer === null || e.arrivalOdometer === undefined ? "" : String(e.arrivalOdometer),
    returnTime: e.arrivalTime,
    dutyOfficer: e.dutySignature,
  };
}

function formToEntry(f: JournalForm, fallbackId: number): JournalEntry {
  return {
    id: f.id || fallbackId,
    date: f.date,
    subdivision: f.unit,
    driver: f.driver,
    waybillNumber: f.waybill,
    brand: f.brand,
    regNumber: f.plate,
    departureCondition: f.techState,
    departureSeal: "",
    departureOdometer: toIntOrNull(f.odometerOut),
    departureTime: f.departTime,
    purpose: "",
    authority: "",
    returnDeadline: "18:00",
    arrivalDate: f.date,
    arrivalTime: f.returnTime,
    arrivalCondition: "",
    arrivalSeal: "",
    arrivalOdometer: toIntOrNull(f.odometerIn),
    remarks: "",
    dutySignature: f.dutyOfficer,
    speedometer: f.speedometer || null,
  };
}

function JournalPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<JournalForm | null>(null);
  const [formData, setFormData] = useState<JournalForm>(EMPTY_FORM);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);

  const queryClient = useQueryClient();

  const { data: journal = [] } = useQuery({
    queryKey: ["journal"],
    queryFn: () => apiGetCollection<JournalEntry>("journal"),
  });

  const saveMutation = useMutation({
    mutationFn: async (data: JournalEntry[]) => apiPutCollection("journal", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["journal"] });
      setModalOpen(false);
      setEditingItem(null);
      setFormData(EMPTY_FORM);
      toast.success("Сохранено");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Ошибка сохранения");
    },
  });

  const nextId = () => Math.max(0, ...journal.map((j) => j.id)) + 1;

  const handleAdd = () => {
    setEditingItem(null);
    setFormData({ ...EMPTY_FORM, date: new Date().toISOString().split("T")[0] });
    setModalOpen(true);
  };

  const handleEdit = (item: JournalEntry) => {
    const form = entryToForm(item);
    setEditingItem(form);
    setFormData(form);
    setModalOpen(true);
  };

  const handleDelete = (id: number) => {
    setDeleteTarget(id);
    setDeleteOpen(true);
  };

  const performDelete = () => {
    if (deleteTarget === null) return;
    saveMutation.mutate(journal.filter((j) => j.id !== deleteTarget));
    setDeleteOpen(false);
    setDeleteTarget(null);
  };

  const handleSave = () => {
    if (!formData.date || !formData.plate) {
      toast.error("Заполните обязательные поля (дата, гос. номер)");
      return;
    }
    const newItem = formToEntry(formData, nextId());
    const updated = editingItem
      ? journal.map((j) => (j.id === editingItem.id ? newItem : j))
      : [...journal, newItem];
    saveMutation.mutate(updated);
  };

  const rows = [...journal]
    .map(entryToForm)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));

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
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-20 text-center text-muted-foreground">
                  Записей в журнале нет
                </td>
              </tr>
            ) : (
              rows.map((item) => (
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
                        onClick={() => {
                          const entry = journal.find((j) => j.id === item.id);
                          if (entry) handleEdit(entry);
                        }}
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
              value={formData.date}
              onChange={(e) => setFormData({ ...formData, date: e.target.value })}
            />
          </Field>
          <Field label="Подразделение">
            <Input
              value={formData.unit}
              onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
            />
          </Field>
          <Field label="Водитель">
            <Input
              value={formData.driver}
              onChange={(e) => setFormData({ ...formData, driver: e.target.value })}
            />
          </Field>
          <Field label="Наряд">
            <Input
              value={formData.waybill}
              onChange={(e) => setFormData({ ...formData, waybill: e.target.value })}
            />
          </Field>
          <Field label="Марка">
            <Input
              value={formData.brand}
              onChange={(e) => setFormData({ ...formData, brand: e.target.value })}
            />
          </Field>
          <Field label="Гос. номер">
            <Input
              value={formData.plate}
              onChange={(e) => setFormData({ ...formData, plate: e.target.value })}
            />
          </Field>
          <Field label="Тех. состояние">
            <Input
              value={formData.techState}
              onChange={(e) => setFormData({ ...formData, techState: e.target.value })}
            />
          </Field>
          <Field label="Спидометр">
            <Input
              value={formData.speedometer}
              onChange={(e) => setFormData({ ...formData, speedometer: e.target.value })}
            />
          </Field>
          <Field label="Одометр (выезд)">
            <Input
              value={formData.odometerOut}
              onChange={(e) => setFormData({ ...formData, odometerOut: e.target.value })}
            />
          </Field>
          <Field label="Время выезда">
            <Input
              type="time"
              value={formData.departTime}
              onChange={(e) => setFormData({ ...formData, departTime: e.target.value })}
            />
          </Field>
          <Field label="Одометр (возврат)">
            <Input
              value={formData.odometerIn}
              onChange={(e) => setFormData({ ...formData, odometerIn: e.target.value })}
            />
          </Field>
          <Field label="Время возврата">
            <Input
              type="time"
              value={formData.returnTime}
              onChange={(e) => setFormData({ ...formData, returnTime: e.target.value })}
            />
          </Field>
          <Field label="Дежурный офицер" className="col-span-2">
            <Input
              value={formData.dutyOfficer}
              onChange={(e) => setFormData({ ...formData, dutyOfficer: e.target.value })}
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
