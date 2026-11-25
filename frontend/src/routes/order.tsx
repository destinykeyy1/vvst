import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Download, FileText } from "lucide-react";
import { Button, Field, Input, Modal, PageHeader, Panel } from "@/components/ui-kit";
import { PasswordGate } from "@/components/PasswordGate";
import { apiGetCollection, apiPutCollection } from "@/lib/api";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type OrderTab = "duty" | "training" | "household" | "other";

interface OrderLine {
  id: number;
  section: string;
  brand: string;
  regNumber: string;
  usageGroup: string;
  driver: string;
  route: string;
  purpose: string;
  departureTime: string;
  returnTime: string;
  responsible: string;
  note: string;
  date?: string;
  scheduleRowId?: number;
}

const TABS: { key: OrderTab; label: string }[] = [
  { key: "duty", label: "Дежурные средства" },
  { key: "training", label: "Учебные средства" },
  { key: "household", label: "Хозяйственная деятельность" },
  { key: "other", label: "Иные мероприятия" },
];

export const Route = createFileRoute("/order")({
  component: () => (
    <PasswordGate section="order" title="Наряд">
      <OrderPage />
    </PasswordGate>
  ),
});

function OrderPage() {
  const [activeTab, setActiveTab] = useState<OrderTab>("duty");
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split("T")[0]);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Set<number> | null>(null);

  const queryClient = useQueryClient();

  const { data: lines = [], isLoading } = useQuery({
    queryKey: ["order-section-lines"],
    queryFn: () => apiGetCollection<OrderLine>("order-section-lines"),
  });

  const filteredLines = lines.filter((line) => line.section === activeTab);

  const saveMutation = useMutation({
    mutationFn: async (data: OrderLine[]) => {
      return apiPutCollection("order-section-lines", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["order-section-lines"] });
      toast.success("Сохранено");
    },
    onError: () => {
      toast.error("Ошибка сохранения");
    },
  });

  const handleAddRow = () => {
    const newLine: OrderLine = {
      id: Date.now(),
      section: activeTab,
      brand: "",
      regNumber: "",
      usageGroup: "",
      driver: "",
      route: "",
      purpose: "",
      departureTime: "",
      returnTime: "",
      responsible: "",
      note: "",
      date: selectedDate,
    };
    const updated = [...lines, newLine];
    saveMutation.mutate(updated);
  };

  const handleDeleteSelected = () => {
    if (selectedRows.size === 0) return;
    setDeleteTarget(selectedRows);
    setDeleteOpen(true);
  };

  const performDelete = () => {
    if (!deleteTarget) return;
    const updated = lines.filter((line) => !deleteTarget.has(line.id));
    saveMutation.mutate(updated);
    setSelectedRows(new Set());
    setDeleteOpen(false);
    setDeleteTarget(null);
  };

  const handleCellEdit = (id: number, field: keyof OrderLine, value: string) => {
    const updated = lines.map((line) =>
      line.id === id ? { ...line, [field]: value } : line
    );
    saveMutation.mutate(updated);
  };

  const toggleRowSelection = (id: number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllRows = () => {
    if (selectedRows.size === filteredLines.length) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(filteredLines.map((l) => l.id)));
    }
  };

  const allSelected = filteredLines.length > 0 && selectedRows.size === filteredLines.length;

  return (
    <div>
      <PageHeader
        title="Наряд"
        subtitle={`Строк в разделе: ${filteredLines.length}`}
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
                  toast.info("Импорт Excel в разработке");
                  e.target.value = "";
                }
              }}
            />
            <Button variant="outline">
              <FileText className="mr-2 h-4 w-4" />
              Перенести в «Наряд»
            </Button>
          </>
        }
      />

      <Panel className="mb-4 flex flex-wrap items-center gap-4 p-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Дата:</span>
          <Input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="w-40"
          />
        </div>
        <Button variant="outline" size="sm">
          Автозаполнение
        </Button>
        <Button variant="outline" size="sm">
          Подбор по расписанию
        </Button>
      </Panel>

      <Panel className="mb-4">
        <div className="flex border-b border-border">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                "px-4 py-2 text-sm transition-colors",
                activeTab === tab.key
                  ? "border-b-2 border-primary font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </Panel>

      <Panel className="thin-scroll max-h-[calc(100vh-28rem)] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr className="border-b border-border">
              <th className="w-12 px-3 py-3">
                <input
                  type="checkbox"
                  aria-label="Выбрать все"
                  checked={allSelected}
                  onChange={toggleAllRows}
                />
              </th>
              <th className="px-3 py-3 text-left">ТС</th>
              <th className="px-3 py-3 text-left">Гос. номер</th>
              <th className="px-3 py-3 text-left">Группа</th>
              <th className="px-3 py-3 text-left">Назначение</th>
              <th className="px-3 py-3 text-left">Маршрут</th>
              <th className="px-3 py-3 text-left">Ответственный</th>
              <th className="px-3 py-3 text-left">Время выезда</th>
              <th className="px-3 py-3 text-left">Время возвращения</th>
              <th className="px-3 py-3 text-left">Дата</th>
              <th className="px-3 py-3 text-left">Примечание</th>
            </tr>
          </thead>
          <tbody>
            {filteredLines.length === 0 ? (
              <tr>
                <td colSpan={10} className="py-20 text-center text-muted-foreground">
                  В этом разделе записей нет
                </td>
              </tr>
            ) : (
              filteredLines.map((line) => (
                <tr key={line.id} className={cn("border-b border-border", selectedRows.has(line.id) && "bg-accent")}>
                  <td className="px-3 py-3 text-center">
                    <input
                      type="checkbox"
                      checked={selectedRows.has(line.id)}
                      onChange={() => toggleRowSelection(line.id)}
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      value={line.brand}
                      onChange={(e) => handleCellEdit(line.id, "brand", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      value={line.regNumber}
                      onChange={(e) => handleCellEdit(line.id, "regNumber", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      value={line.usageGroup}
                      onChange={(e) => handleCellEdit(line.id, "usageGroup", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      value={line.purpose}
                      onChange={(e) => handleCellEdit(line.id, "purpose", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      value={line.route}
                      onChange={(e) => handleCellEdit(line.id, "route", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      value={line.responsible}
                      onChange={(e) => handleCellEdit(line.id, "responsible", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      type="time"
                      value={line.departureTime}
                      onChange={(e) => handleCellEdit(line.id, "departureTime", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      type="time"
                      value={line.returnTime}
                      onChange={(e) => handleCellEdit(line.id, "returnTime", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      type="date"
                      value={line.date || ""}
                      onChange={(e) => handleCellEdit(line.id, "date", e.target.value)}
                      className="h-8"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <Input
                      value={line.note}
                      onChange={(e) => handleCellEdit(line.id, "note", e.target.value)}
                      className="h-8"
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>

      <Panel className="mt-4 flex gap-2 p-3">
        <Button variant="danger" onClick={handleDeleteSelected} disabled={selectedRows.size === 0}>
          <Trash2 className="mr-2 h-4 w-4" />
          Удалить выбранные ({selectedRows.size})
        </Button>
        <Button onClick={handleAddRow}>
          <Plus className="mr-2 h-4 w-4" />
          Добавить строку
        </Button>
        <Button variant="outline" disabled={true}>
          Сохранить изменения
        </Button>
      </Panel>

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
        <p className="text-sm">
          Вы уверены, что хотите удалить выбранные строки ({deleteTarget?.size ?? 0})? Это действие нельзя отменить.
        </p>
      </Modal>
    </div>
  );
}