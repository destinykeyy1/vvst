import { createFileRoute } from "@tanstack/react-router";
import { SchedulePage } from "@/components/pages/SchedulePage";
import { PasswordGate } from "@/components/PasswordGate";

export const Route = createFileRoute("/events")({
  component: () => (
    <PasswordGate section="events" title="Расписание иных мероприятий">
      <SchedulePage
        kind="other"
        title="РАСПИСАНИЕ ИНЫХ МЕРОПРИЯТИЙ"
        subtitle="Всего мероприятий в месяце"
        collectionName="other_schedules"
        columns={{
          name: "НАИМЕНОВАНИЕ МЕРОПРИЯТИЯ",
          location: "МЕСТО",
          brands: "МАРКА МАШИН (КОЛ-ВО)",
          start: "НАЧАЛО",
        }}
      />
    </PasswordGate>
  ),
});