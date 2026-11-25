import { createFileRoute } from "@tanstack/react-router";
import { WriteOffPage } from "@/components/pages/WriteOffPage";
import { pageHead } from "@/lib/head";

export const Route = createFileRoute("/writeoff/tarps")({
  head: () => pageHead("Списание брезентов", "Учёт списания брезентов и тентов."),
  component: Page,
});

function Page() {
  return <WriteOffPage kind="tarps" title="Списание брезентов" itemLabel="Наименование брезента" />;
}
