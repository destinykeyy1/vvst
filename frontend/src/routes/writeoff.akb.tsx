import { createFileRoute } from "@tanstack/react-router";
import { WriteOffPage } from "@/components/pages/WriteOffPage";
import { pageHead } from "@/lib/head";

export const Route = createFileRoute("/writeoff/akb")({
  head: () => pageHead("Списание АКБ", "Учёт списания аккумуляторных батарей."),
  component: Page,
});

function Page() {
  return <WriteOffPage kind="akb" title="Списание АКБ" itemLabel="Тип АКБ" />;
}
