import { createFileRoute } from "@tanstack/react-router";
import { WriteOffPage } from "@/components/pages/WriteOffPage";
import { PasswordGate } from "@/components/PasswordGate";

export const Route = createFileRoute("/writeoff/tires")({
  component: Page,
});

function Page() {
  return (
    <PasswordGate section="writeoff/tires" title="Списание шин">
      <WriteOffPage kind="tires" title="Списание шин" itemLabel="Модель / размер шины" />
    </PasswordGate>
  );
}
