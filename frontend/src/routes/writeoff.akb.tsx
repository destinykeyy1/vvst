import { createFileRoute } from "@tanstack/react-router";
import { WriteOffPage } from "@/components/pages/WriteOffPage";
import { PasswordGate } from "@/components/PasswordGate";

export const Route = createFileRoute("/writeoff/akb")({
  component: Page,
});

function Page() {
  return (
    <PasswordGate section="writeoff/akb" title="Списание АКБ">
      <WriteOffPage kind="akb" title="Списание АКБ" itemLabel="Тип АКБ" />
    </PasswordGate>
  );
}
