import { createFileRoute } from "@tanstack/react-router";
import { WriteOffPage } from "@/components/pages/WriteOffPage";
import { PasswordGate } from "@/components/PasswordGate";

export const Route = createFileRoute("/writeoff/tarps")({
  component: Page,
});

function Page() {
  return (
    <PasswordGate section="writeoff/tarps" title="Списание брезентов">
      <WriteOffPage kind="tarps" title="Списание брезентов" itemLabel="Наименование брезента" />
    </PasswordGate>
  );
}
