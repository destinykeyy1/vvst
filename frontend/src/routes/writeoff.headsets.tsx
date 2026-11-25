import { createFileRoute } from "@tanstack/react-router";
import { WriteOffPage } from "@/components/pages/WriteOffPage";
import { pageHead } from "@/lib/head";

export const Route = createFileRoute("/writeoff/headsets")({
  head: () => pageHead("Списание шлемофонов", "Учёт списания шлемофонов."),
  component: Page,
});

function Page() {
  return <WriteOffPage kind="headsets" title="Списание шлемофонов" itemLabel="Тип шлемофона" />;
}
