import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, Save, RefreshCw } from "lucide-react";
import { Button, Field, Input, PageHeader, Panel } from "@/components/ui-kit";
import { PasswordGate } from "@/components/PasswordGate";
import { apiGetVehicleDetails, apiPutVehicleDetails, type VehicleDetails } from "@/lib/api";
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

function CardDetailPage() {
  const { vehicleId } = Route.useParams();
  const navigate = useNavigate();
  const numVehicleId = parseInt(vehicleId, 10);

  const { data: details, isLoading, refetch } = useQuery({
    queryKey: ["vehicle-details", numVehicleId],
    queryFn: () => apiGetVehicleDetails(numVehicleId),
  });

  const [edited, setEdited] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

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
      toast.success("Карточка сохранена");
    } catch (error) {
      toast.error("Ошибка сохранения карточки");
      console.error(error);
    } finally {
      setSaving(false);
    }
  };

  const getFieldValue = (field: string) => {
    if (edited[field] !== undefined) return edited[field];
    if (details?.certificate?.individualCardFields?.[field]) {
      return details.certificate.individualCardFields[field];
    }
    return ABSENT;
  };

  const handleFieldChange = (field: string, value: string) => {
    setEdited((prev) => ({
      ...prev,
      [field]: value === ABSENT ? "" : value,
    }));
  };

  if (isLoading) {
    return (
      <div>
        <PageHeader title="Индивидуальная карточка ВВСТ" />
        <Panel className="p-6 text-center text-muted-foreground">Загрузка...</Panel>
      </div>
    );
  }

  if (!details) {
    return (
      <div>
        <PageHeader title="Индивидуальная карточка ВВСТ" />
        <Panel className="p-6 text-center text-muted-foreground">Карточка не найдена</Panel>
      </div>
    );
  }

  const certificate = details.certificate;
  const cardFields = certificate?.individualCardFields || {};

  return (
    <div>
      <PageHeader
        title="ИНДИВИДУАЛЬНАЯ КАРТОЧКА ВВСТ"
        subtitle={certificate ? `${certificate.brandModel}, ${certificate.regNumber}` : "Данные паспорта"}
        actions={
          <>
            <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
              <RefreshCw className={cn("mr-2 h-4 w-4", isLoading && "animate-spin")} />
              Обновить
            </Button>
            <Button onClick={handleSave} disabled={!hasChanges || saving}>
              <Save className="mr-2 h-4 w-4" />
              Сохранить
            </Button>
          </>
        }
      />

      <div className="mb-4">
        <Link to="/card">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Назад к списку
          </Button>
        </Link>
      </div>

      <Panel className="p-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CARD_FIELDS.map((field) => {
            const value = getFieldValue(field);
            const isEdited = edited[field] !== undefined;
            const isAbsent = value === ABSENT || value === "";

            return (
              <Field key={field} label={field}>
                <Input
                  value={isAbsent ? ABSENT : value}
                  onChange={(e) => handleFieldChange(field, e.target.value)}
                  className={cn(
                    isAbsent && "text-muted-foreground",
                    isEdited && "border-warning bg-warning-soft",
                  )}
                />
              </Field>
            );
          })}
        </div>
      </Panel>

      {hasChanges && (
        <div className="mt-4 text-sm text-muted-foreground">
          Есть несохранённые изменения ({Object.keys(edited).length})
        </div>
      )}
    </div>
  );
}
