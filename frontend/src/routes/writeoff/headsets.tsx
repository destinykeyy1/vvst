import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, Panel } from "@/components/ui-kit";
import { PasswordGate } from "@/components/PasswordGate";

export const Route = createFileRoute("/writeoff/headsets")({
  component: () => (
    <PasswordGate section="writeoff/headsets" title="Списание шлемофонов">
      <div>
        <PageHeader title="Списание шлемофонов" />
        <Panel className="p-6 text-sm text-muted-foreground">Раздел в разработке.</Panel>
      </div>
    </PasswordGate>
  ),
});