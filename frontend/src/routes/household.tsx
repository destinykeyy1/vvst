import { createFileRoute } from "@tanstack/react-router";
import { SchedulePage } from "@/components/pages/SchedulePage";
import { PasswordGate } from "@/components/PasswordGate";

export const Route = createFileRoute("/household")({
  component: () => (
    <PasswordGate section="household" title="Хозяйственная деятельность">
      <SchedulePage
        kind="household"
        title="ХОЗЯЙСТВЕННАЯ ДЕЯТЕЛЬНОСТЬ"
        subtitle="Всего мероприятий в месяце"
        collectionName="household-schedules"
        columns={{
          name: "НАИМЕНОВАНИЕ МЕРОПРИЯТИЯ",
          location: "МЕСТО",
          brands: "МАРКИ МАШИН (КОЛ-ВО)",
        }}
      />
    </PasswordGate>
  ),
});