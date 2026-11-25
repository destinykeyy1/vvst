import { useState } from "react";
import type { Vehicle, VehicleType } from "@/lib/types";
import { Button, Field, Input, Modal, Select } from "./ui-kit";

export const TYPE_LABELS: Record<VehicleType, string> = {
  auto: "Автомобильная",
  tracked: "Бронетанковая (гусеничная)",
  snow: "Снегоходы",
  other: "Прочая",
};

export type VehicleDraft = Omit<Vehicle, "id" | "details" | "status" | "statusReason">;

const EMPTY: VehicleDraft = {
  unit: "1 АО (учебное) отдела (УБМ)",
  brand: "",
  year: new Date().getFullYear(),
  commissionDate: "",
  order: "",
  plate: "",
  group: "УЧ",
  assignedTo: "",
  type: "auto",
  mileage: 0,
  motoHours: 0,
};

export function VehicleFormModal({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (v: VehicleDraft) => void;
}) {
  const [draft, setDraft] = useState<VehicleDraft>(EMPTY);
  const set = <K extends keyof VehicleDraft>(k: K, v: VehicleDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const valid = draft.brand.trim() && draft.plate.trim();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Добавить машину"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              onSave(draft);
              setDraft(EMPTY);
            }}
          >
            Добавить
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Марка машины *">
          <Input value={draft.brand} onChange={(e) => set("brand", e.target.value)} placeholder="УАЗ-3163-103-61" />
        </Field>
        <Field label="Гос. рег. знак *">
          <Input value={draft.plate} onChange={(e) => set("plate", e.target.value)} placeholder="5349 АК 76 RUS" />
        </Field>
        <Field label="Подразделение">
          <Input value={draft.unit} onChange={(e) => set("unit", e.target.value)} />
        </Field>
        <Field label="Тип">
          <Select value={draft.type} onChange={(e) => set("type", e.target.value as VehicleType)}>
            {Object.entries(TYPE_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Год выпуска">
          <Input type="number" value={draft.year} onChange={(e) => set("year", Number(e.target.value))} />
        </Field>
        <Field label="Дата ввода в эксплуатацию">
          <Input value={draft.commissionDate} onChange={(e) => set("commissionDate", e.target.value)} placeholder="01.01.2026" />
        </Field>
        <Field label="Группа эксплуатации">
          <Input value={draft.group} onChange={(e) => set("group", e.target.value)} />
        </Field>
        <Field label="Закреплённый водитель">
          <Input value={draft.assignedTo} onChange={(e) => set("assignedTo", e.target.value)} />
        </Field>
        <Field label="Пробег, км">
          <Input type="number" value={draft.mileage} onChange={(e) => set("mileage", Number(e.target.value))} />
        </Field>
        <Field label="Моточасы">
          <Input type="number" value={draft.motoHours} onChange={(e) => set("motoHours", Number(e.target.value))} />
        </Field>
        <div className="col-span-2">
          <Field label="Наряд на получение (передачу) ВВСТ">
            <Input value={draft.order} onChange={(e) => set("order", e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
