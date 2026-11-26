import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, Save, RefreshCw } from "lucide-react";
import { Button, Input, Modal } from "@/components/ui-kit";
import { PasswordGate } from "@/components/PasswordGate";
import { apiGetVehicleDetails, apiPutVehicleDetails, ApiError, type VehicleDetails } from "@/lib/api";
import { useAppState } from "@/lib/store";
import { CARD_FIELDS, ABSENT } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/card/$vehicleId")({
  component: () => (
    <PasswordGate section="card" title="Индивидуальная карточка ВВСТ">
      <CardDetailPage />
    </PasswordGate>
  ),
});

const passportRows: Record<string, string> = {
  "Марка машины": "1",
  "Паспорт (формуляр) машины": "2",
  "Заводской номер": "3",
  "Идентификационный номер (VIN)": "4",
  "Номер шасси": "5",
  "Номер кузова": "6",
  "Номер кабины": "7",
  "Номер кунга": "8",
  "Номер корпуса": "9",
  "Номер башни": "10",
  "Марка двигателя": "11",
  "Номер двигателя": "12",
  "Специальное оборудование (марка, тип, номер)": "13",
  "Марка установленных АКБ": "24",
  "Количество АКБ": "25",
  "Дата приведения (установки) АКБ": "26",
  "Марка, модель и размер шин": "27",
  "Количество шин": "28",
  "Номера шин": "29",
  "Наработка с начала эксплуатации": "30",
  "Группа эксплуатации": "31",
  "Подразделение": "32",
  "Закрепленный водитель (механик-водитель)": "33"
};

function CardDetailPage() {
  const { vehicleId } = Route.useParams();
  const navigate = useNavigate();
  const numVehicleId = parseInt(vehicleId, 10);

  const { data: details, isLoading, refetch } = useQuery({
    queryKey: ["vehicle-details", numVehicleId],
    queryFn: async (): Promise<VehicleDetails> => {
      try {
        return await apiGetVehicleDetails(numVehicleId);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          return {
            vehicleId: numVehicleId,
            certificate: null,
            batteries: [],
            tires: [],
            maintenance: [],
            history: [],
          };
        }
        throw e;
      }
    },
  });

  const vehicle = useAppState((s) => s.vehicles.find((v) => v.id === numVehicleId));

  const [edited, setEdited] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [editing, setEditing] = useState(false);
  const [hideAbsent, setHideAbsent] = useState(false);
  const hasChanges = Object.keys(edited).length > 0;

  const handleSave = async () => {
    if (!details || saving) return;
    setSaving(true);
    try {
      const certificate = details.certificate || {
        type: "AT" as const,
        brandModel: "",
        regNumber: "",
        issuedBy: "",
        issueDate: "",
        weapons: [],
        extraFields: [],
        individualCardFields: {},
      };

      const updated: VehicleDetails = {
        ...details,
        certificate: {
          ...certificate,
          individualCardFields: {
            ...certificate.individualCardFields,
            ...edited,
          },
        },
      };
      await apiPutVehicleDetails(numVehicleId, updated);
      await refetch();
      setEdited({});
      setEditing(false);
      toast.success("Карточка сохранена");
    } catch (error) {
      toast.error("Ошибка сохранения карточки");
      console.error(error);
    } finally {
      setSaving(false);
    }
  };

  const getFieldValue = (field: string) => {
    const key = passportRows[field] ?? field;
    if (edited[key] !== undefined) return edited[key];
    const certificate = details?.certificate;
    const fallback: Record<string, unknown> = {
      "Марка машины": certificate?.brandModel || vehicle?.brand,
      "Заводской номер": certificate?.factoryNumber,
      "Идентификационный номер (VIN)": certificate?.vin,
      "Номер шасси": certificate?.chassisNumber, "Номер кузова": certificate?.bodyNumber,
      "Номер кабины": certificate?.cabinNumber, "Номер кунга": certificate?.kungNumber,
      "Номер корпуса": certificate?.hullNumber, "Номер башни": certificate?.turretNumber,
      "Марка двигателя": certificate?.engineBrand, "Номер двигателя": certificate?.engineNumber,
      "Год выпуска": certificate?.yearOfManufacture || vehicle?.year || undefined,
      "Государственный регистрационный знак": certificate?.regNumber || vehicle?.plate,
      "Группа эксплуатации": certificate?.usageGroup || vehicle?.group,
      "Подразделение": certificate?.subdivision || vehicle?.unit,
      "Дата ввода в эксплуатацию": vehicle?.commissionDate,
      "Закреплённый водитель": vehicle?.assignedTo
    };
    const values = [certificate?.individualCardFields?.[key], certificate?.individualCardFields?.[field], vehicle?.details[field], certificate?.extraFields?.find(item => item.name === field)?.value, fallback[field]];
    return String(values.find(value => value != null && String(value).trim() && String(value).trim().toUpperCase() !== ABSENT) ?? "");
  };

  const handleFieldChange = (field: string, value: string) => {
    setEdited((prev) => ({
      ...prev,
      [passportRows[field] ?? field]: value === ABSENT ? "" : value,
    }));
  };

  const close = () => navigate({ to: "/card" });
  return <Modal open onClose={close} size="lg" title="Индивидуальная карточка ВВСТ"
    subtitle={[vehicle?.brand, vehicle?.plate].filter(Boolean).join(" · ")}
    footer={editing ? <><Button variant="outline" onClick={() => { setEdited({}); setEditing(false); }}>Отмена</Button><Button disabled={saving || !hasChanges} onClick={handleSave}>Сохранить</Button></> : <Button disabled={!details} onClick={() => setEditing(true)}>Редактировать</Button>}>
    {isLoading ? "Загрузка…" : !details ? "Не удалось загрузить карточку" : <>
      <div className="border border-neutral-300 py-3 text-center text-sm">
        <div className="eyebrow">Учётная карточка</div>
        <div className="mt-1 font-semibold">{vehicle?.brand}</div>
        Государственный регистрационный знак: {vehicle?.plate}
      </div>
      <div className="my-3 flex justify-end"><Button variant="outline" aria-pressed={hideAbsent} onClick={() => setHideAbsent(!hideAbsent)}>{hideAbsent ? "Показать отсутствующее" : "Скрыть отсутствующее"}</Button></div>
      <table className="w-full border-collapse text-sm [&_td]:border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:px-3 [&_th]:py-2">
        <thead className="bg-neutral-100 text-left text-xs uppercase text-neutral-600"><tr><th>№</th><th>Наименование данных</th><th>Сведения</th></tr></thead>
        <tbody>{Array.from(new Set([...CARD_FIELDS, ...Object.keys(passportRows)])).map((field, i) => {
          const value = getFieldValue(field) || (field === "Марка машины" ? vehicle?.brand : "") || "";
          if (hideAbsent && !value.trim() && !editing) return null;
          return <tr key={field} className="even:bg-neutral-50"><td className="w-14 text-center text-neutral-500">{i + 1}</td><td className="w-2/5">{field}</td><td>{editing ? <Input aria-label={field} value={value} onChange={e => handleFieldChange(field, e.target.value)} /> : value || ABSENT}</td></tr>;
        })}</tbody>
      </table>
    </>}
  </Modal>;
}
