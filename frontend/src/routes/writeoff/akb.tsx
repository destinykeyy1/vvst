import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, Panel } from "@/components/ui-kit";
import { PasswordGate } from "@/components/PasswordGate";

export const Route = createFileRoute("/writeoff/akb")({
  component: () => (
    <PasswordGate section="writeoff/akb" title="Списание АКБ">
      <div>
        <PageHeader title="Списание АКБ" />
        <Panel className="p-6 text-sm text-muted-foreground">Раздел в разработке.</Panel>
      </div>
    </PasswordGate>
  ),
});