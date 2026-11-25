import { createFileRoute } from "@tanstack/react-router";
import { WriteOffPage } from "@/components/pages/WriteOffPage";
import { pageHead } from "@/lib/head";

export const Route = createFileRoute("/writeoff/tires")({
  head: () => pageHead("Списание шин", "Учёт списания автомобильных шин."),
  component: Page,
});

function Page() {
  return <WriteOffPage kind="tires" title="Списание шин" itemLabel="Модель / размер шины" />;
}
