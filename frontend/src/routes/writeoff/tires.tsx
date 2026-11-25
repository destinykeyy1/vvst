import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, Panel } from "@/components/ui-kit";
import { PasswordGate } from "@/components/PasswordGate";

export const Route = createFileRoute("/writeoff/tires")({
  component: () => (
    <PasswordGate section="writeoff/tires" title="Списание шин">
      <div>
        <PageHeader title="Списание шин" />
        <Panel className="p-6 text-sm text-muted-foreground">Раздел в разработке.</Panel>
      </div>
    </PasswordGate>
  ),
});