import { createFileRoute } from "@tanstack/react-router";
import { SchedulePage } from "@/components/pages/SchedulePage";
import { PasswordGate } from "@/components/PasswordGate";

export const Route = createFileRoute("/oup")({
  component: () => (
    <PasswordGate section="oup" title="Расписание ОУП">
      <SchedulePage
        kind="oup"
        title="РАСПИСАНИЕ ОУП"
        subtitle="Всего занятий в месяце"
        collectionName="schedules"
        columns={{
          name: "НАИМЕНОВАНИЕ ЗАНЯТИЯ",
          location: "МЕСТО",
          brands: "МАРКИ МАШИН - КОЛ-ВО",
          instructor: "ПРЕПОДАВАТЕЛЬ (СТАРШИЙ КОЛОННЫ)",
        }}
      />
    </PasswordGate>
  ),
});