export type OrderTab = "duty" | "training" | "household" | "other";

export const orderTabs: { key: OrderTab; label: string }[] = [
  { key: "duty", label: "Дежурные средства" },
  { key: "training", label: "Учебные средства" },
  { key: "household", label: "Хозяйственная деятельность" },
  { key: "other", label: "Иные мероприятия" },
];
