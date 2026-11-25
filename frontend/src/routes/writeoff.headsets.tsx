import { createFileRoute } from "@tanstack/react-router";
import { WriteOffPage } from "@/components/pages/WriteOffPage";
import { PasswordGate } from "@/components/PasswordGate";

export const Route = createFileRoute("/writeoff/headsets")({
  component: Page,
});

function Page() {
  return (
    <PasswordGate section="writeoff/headsets" title="Списание шлемофонов">
      <WriteOffPage kind="headsets" title="Списание шлемофонов" itemLabel="Тип шлемофона" />
    </PasswordGate>
  );
}
