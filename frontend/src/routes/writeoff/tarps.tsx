import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, Panel } from "@/components/ui-kit";
import { PasswordGate } from "@/components/PasswordGate";

export const Route = createFileRoute("/writeoff/tarps")({
  component: () => (
    <PasswordGate section="writeoff/tarps" title="Списание брезентов">
      <div>
        <PageHeader title="Списание брезентов" />
        <Panel className="p-6 text-sm text-muted-foreground">Раздел в разработке.</Panel>
      </div>
    </PasswordGate>
  ),
});