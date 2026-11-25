import { useMemo, useState } from "react";
import { ArrowUpDown, Download } from "lucide-react";
import { Button, Input, PageHeader, Panel, Select, StatCard } from "@/components/ui-kit";
import { cn } from "@/lib/utils";

type WriteOffKind = "akb" | "tires" | "headsets" | "tarps";

interface WriteOffPageProps {
  kind: WriteOffKind;
  title: string;
  itemLabel: string;
}

interface WriteOffItem {
  id: number;
  vehicle: string;
  vehiclePlate: string;
  vehicleId: string;
  item: string;
  itemDetail?: string;
  quantity: number;
  numbers?: string;
  installDate: string;
  serviceLife: string;
  norm: string;
  actual: string;
  remaining: string;
  status: "ok" | "warning" | "expired";
  reason: string;
}

const MOCK_DATA: Record<WriteOffKind, WriteOffItem[]> = {
  akb: [
    {
      id: 1,
      vehicle: "КАМАЗ-43501",
      vehiclePlate: "5756 AK 76 RUS",
      vehicleId: "XTC43501CJ2517094",
      item: "6СТ-190",
      itemDetail: "Основная",
      quantity: 2,
      numbers: "12345, 12346",
      installDate: "10.03.2005",
      serviceLife: "20 лет",
      norm: "20 лет",
      actual: "20 лет 8 мес.",
      remaining: "просрочено на 0 лет 8 мес.",
      status: "expired",
      reason: "Срок службы превышен (20 лет 8 мес)",
    },
    {
      id: 2,
      vehicle: "Урал-4320",
      vehiclePlate: "А123БВ 77 RUS",
      vehicleId: "XTC4320XX1234567",
      item: "6СТ-190",
      itemDetail: "Основная",
      quantity: 2,
      numbers: "23456, 23457",
      installDate: "15.06.2010",
      serviceLife: "20 лет",
      norm: "20 лет",
      actual: "15 лет 5 мес.",
      remaining: "4 года 7 мес.",
      status: "ok",
      reason: "—",
    },
  ],
  tires: [
    {
      id: 1,
      vehicle: "КАМАЗ-43501",
      vehiclePlate: "5756 AK 76 RUS",
      vehicleId: "XTC43501CJ2517094",
      item: "425/85R21 NORTEC TR-184-1",
      itemDetail: "Основная",
      quantity: 4,
      numbers: "В01-В04",
      installDate: "20.05.2020",
      serviceLife: "50 000 км",
      norm: "50 000 км",
      actual: "52 000 км",
      remaining: "просрочено на 2 000 км",
      status: "expired",
      reason: "Пробег превышен (52 000 км)",
    },
    {
      id: 2,
      vehicle: "БМП-3",
      vehiclePlate: "100",
      vehicleId: "X12ГТ7108",
      item: "530/70R21",
      itemDetail: "Основная",
      quantity: 6,
      numbers: "В01-В06",
      installDate: "10.03.2022",
      serviceLife: "50 000 км",
      norm: "50 000 км",
      actual: "25 000 км",
      remaining: "25 000 км",
      status: "ok",
      reason: "—",
    },
  ],
  headsets: [
    {
      id: 1,
      vehicle: "БМД-4М",
      vehiclePlate: "223",
      vehicleId: "2К05Ж17957",
      item: "ТШ-3",
      quantity: 1,
      installDate: "10.03.2020",
      serviceLife: "6 лет",
      norm: "6 лет",
      actual: "6 лет 8 мес.",
      remaining: "просрочено на 0 лет 8 мес.",
      status: "expired",
      reason: "Срок превышен (6 лет)",
    },
    {
      id: 2,
      vehicle: "БТР-82А",
      vehiclePlate: "456",
      vehicleId: "3Л06Ж23456",
      item: "ТШ-Л",
      quantity: 1,
      installDate: "15.06.2021",
      serviceLife: "5 лет",
      norm: "5 лет",
      actual: "4 года 5 мес.",
      remaining: "7 мес.",
      status: "warning",
      reason: "Срок истекает",
    },
  ],
  tarps: [
    {
      id: 1,
      vehicle: "БМП-3",
      vehiclePlate: "100",
      vehicleId: "X12ГТ7108",
      item: "Брезент",
      quantity: 1,
      installDate: "04.03.2020",
      serviceLife: "6 лет",
      norm: "6 лет",
      actual: "6 лет 8 мес.",
      remaining: "просрочено на 0 лет 8 мес.",
      status: "expired",
      reason: "Срок службы превышен (6 лет)",
    },
    {
      id: 2,
      vehicle: "БТР-82А",
      vehiclePlate: "456",
      vehicleId: "3Л06Ж23456",
      item: "Тент",
      quantity: 1,
      installDate: "10.06.2021",
      serviceLife: "5 лет",
      norm: "5 лет",
      actual: "4 года 5 мес.",
      remaining: "7 мес.",
      status: "warning",
      reason: "Срок истекает",
    },
  ],
};

const PAGE_CONFIG: Record<WriteOffKind, { subtitle: string; exportLabel1: string; exportLabel2: string; infoText: string; cards: { label: string; value: number }[]; columns: { key: string; label: string; width: number }[] }> = {
  akb: {
    subtitle: "Аккумуляторы с истекшим сроком службы или отметкой о списании в паспорте АБТС",
    exportLabel1: "Экспорт Word списание АКБ",
    exportLabel2: "Экспорт Word изменение АКБ",
    infoText: "В Word сохраняются непаспортные значения исходного образца сведений об автомобилях и АКБ заменяются данными паспортов, дата акта устанавливается на сегодня.",
    cards: [
      { label: "МАШИН ТРЕБУЮТ ЗАМЕНЫ АКБ", value: 102 },
      { label: "ГРУПП АККУМУЛЯТОРОВ", value: 112 },
    ],
    columns: [
      { key: "vehicle", label: "Машина / паспорт", width: 280 },
      { key: "item", label: "АКБ", width: 180 },
      { key: "numbers", label: "Завод / номер", width: 140 },
      { key: "quantity", label: "Количество", width: 90 },
      { key: "installDate", label: "Дата изготовления", width: 120 },
      { key: "installDate", label: "Дата установки", width: 120 },
      { key: "serviceLife", label: "Срок службы", width: 100 },
      { key: "reason", label: "Основание", width: 250 },
    ],
  },
  tires: {
    subtitle: "Шины с исчерпанным и остатком ресурса или отметкой о списании в паспорте АБТС",
    exportLabel1: "Экспорт Word списание шин",
    exportLabel2: "Экспорт Word изменение шин",
    infoText: "В Word сохраняются инвентарные значения исходного образца; сведения об автомобилях и шинах изменяются данными паспортов, дата акта устанавливается на сегодня.",
    cards: [
      { label: "МАШИН ТРЕБУЮТ ЗАМЕНЫ ШИН", value: 41 },
      { label: "ГРУПП ШИН", value: 42 },
    ],
    columns: [
      { key: "vehicle", label: "Машина / паспорт", width: 280 },
      { key: "item", label: "Шины", width: 200 },
      { key: "quantity", label: "Количество", width: 90 },
      { key: "numbers", label: "Номера", width: 120 },
      { key: "installDate", label: "Дата установки", width: 120 },
      { key: "norm", label: "Норма, км", width: 100 },
      { key: "actual", label: "Фактический пробег", width: 130 },
      { key: "reason", label: "Основание", width: 200 },
    ],
  },
  headsets: {
    subtitle: "ТШ-3, ТШ-Л по данным паспортов АБТС (ТШ-3 — 6 лет, ТШ-Л — 5 лет)",
    exportLabel1: "Экспорт Word списание",
    exportLabel2: "Экспорт Word изменение",
    infoText: "В Word попадут только отмеченные позиции. Для каждого вида имущества формируется отдельный акт.",
    cards: [
      { label: "ПОЗИЦИЙ В ПАСПОРТАХ", value: 198 },
      { label: "ПОДЛЕЖАТ СПИСАНИЮ", value: 14 },
      { label: "МАШИН С ПРОСРОЧЕННЫМ ИМУЩЕСТВОМ", value: 13 },
    ],
    columns: [
      { key: "vehicle", label: "Машина / паспорт", width: 280 },
      { key: "item", label: "Имущество", width: 120 },
      { key: "installDate", label: "Дата установки", width: 120 },
      { key: "actual", label: "Срок службы (факт)", width: 140 },
      { key: "norm", label: "Норматив", width: 100 },
      { key: "remaining", label: "Остаток", width: 160 },
      { key: "status", label: "Статус", width: 140 },
      { key: "reason", label: "Основание", width: 200 },
    ],
  },
  tarps: {
    subtitle: "Брезент по данным паспортов АБТС (норма 5 лет авто / 6 лет бронетехника)",
    exportLabel1: "Экспорт Word списание",
    exportLabel2: "Экспорт Word изменение",
    infoText: "В Word попадут только отмеченные позиции. Для каждого вида имущества формируется отдельный акт.",
    cards: [
      { label: "ПОЗИЦИЙ В ПАСПОРТАХ", value: 94 },
      { label: "ПОДЛЕЖАТ СПИСАНИЮ", value: 9 },
      { label: "МАШИН С ПРОСРОЧЕННЫМ ИМУЩЕСТВОМ", value: 9 },
    ],
    columns: [
      { key: "vehicle", label: "Машина / паспорт", width: 280 },
      { key: "item", label: "Имущество", width: 120 },
      { key: "installDate", label: "Дата установки", width: 120 },
      { key: "actual", label: "Срок службы (факт)", width: 140 },
      { key: "norm", label: "Норматив", width: 100 },
      { key: "remaining", label: "Остаток", width: 160 },
      { key: "status", label: "Статус", width: 140 },
      { key: "reason", label: "Основание", width: 200 },
    ],
  },
};

export function WriteOffPage({ kind, title, itemLabel }: WriteOffPageProps) {
  const config = PAGE_CONFIG[kind];
  const data = MOCK_DATA[kind];
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "vehicle", dir: 1 });

  const filteredData = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.filter(
      (item) =>
        !q ||
        item.vehicle.toLowerCase().includes(q) ||
        item.vehiclePlate.toLowerCase().includes(q) ||
        item.vehicleId.toLowerCase().includes(q) ||
        item.item.toLowerCase().includes(q),
    );
  }, [data, query]);

  const sortedData = useMemo(() => {
    const list = [...filteredData];
    if (sort.key !== "vehicle") {
      list.sort((a, b) => {
        const aVal = (a as any)[sort.key] || "";
        const bVal = (b as any)[sort.key] || "";
        return String(aVal) > String(bVal) ? 1 : String(aVal) < String(bVal) ? -1 : 0;
      });
    }
    if (sort.dir === -1) list.reverse();
    return list;
  }, [filteredData, sort]);

  const allSelected = sortedData.length > 0 && sortedData.every((item) => selected.has(item.id));
  const selectedCount = selected.size;

  const toggleSort = (key: string) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  return (
    <div>
      <PageHeader
        title={title}
        subtitle={config.subtitle}
        actions={
          <>
            <Button variant="outline" className="text-muted-foreground">
              <Download className="mr-2 h-4 w-4" />
              {config.exportLabel1} ({selectedCount})
            </Button>
            <Button variant="outline" className="border-border">
              <Download className="mr-2 h-4 w-4" />
              {config.exportLabel2} ({selectedCount})
            </Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {config.cards.map((card, idx) => (
          <StatCard key={idx} label={card.label} value={card.value} />
        ))}
      </div>

      <p className="mb-4 text-xs text-muted-foreground">{config.infoText}</p>

      <Panel className="mb-4 flex flex-wrap gap-2 p-3">
        <Button variant="outline" onClick={() => setSelected(allSelected ? new Set() : new Set(sortedData.map((item) => item.id)))}>
          {allSelected ? "Снять выбор" : "Выбрать все"}
        </Button>
        <span className="flex items-center text-sm text-muted-foreground">
          Выбрано {kind === "akb" || kind === "tires" ? "машин" : "позиций"}: {selectedCount} из {data.length}
        </span>
        <Input className="w-80" placeholder={`Поиск: марка, номер, ${itemLabel.toLowerCase()}...`} value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="ml-auto text-xs text-muted-foreground">Показано: {sortedData.length} из {data.length}</span>
      </Panel>

      <Panel className="thin-scroll max-h-[calc(100vh-24rem)] overflow-auto">
        <table className="w-max min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr className="border-b border-border">
              <th className="w-12 px-3 py-3">
                <input
                  type="checkbox"
                  aria-label="Выбрать все"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(sortedData.map((item) => item.id)))}
                />
              </th>
              {config.columns.map((col) => (
                <th
                  key={col.key}
                  style={{ minWidth: col.width, maxWidth: col.width }}
                  className="th-cell px-3 py-3 align-middle"
                >
                  <button onClick={() => toggleSort(col.key)} className="flex w-full items-center gap-2 text-left">
                    <span>{col.label}</span>
                    <ArrowUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedData.map((item) => (
              <tr key={item.id} className={cn("border-b border-border", selected.has(item.id) && "bg-accent")}>
                <td className="px-3 py-3 text-center">
                  <input
                    type="checkbox"
                    aria-label={`Выбрать ${item.vehicle}`}
                    checked={selected.has(item.id)}
                    onChange={() => {
                      setSelected((s) => {
                        const next = new Set(s);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      });
                    }}
                  />
                </td>
                <td className="px-3 py-3">
                  <div className="font-medium">{item.vehicle}</div>
                  <div className="text-xs text-muted-foreground">{item.vehiclePlate}, {item.vehicleId}</div>
                </td>
                <td className="px-3 py-3">
                  <div>{item.item}</div>
                  {item.itemDetail && <div className="text-xs text-muted-foreground">{item.itemDetail}</div>}
                </td>
                {kind === "akb" || kind === "tires" ? (
                  <>
                    <td className="px-3 py-3">{item.numbers || "—"}</td>
                    <td className="px-3 py-3">{item.quantity}</td>
                    <td className="px-3 py-3">{item.installDate}</td>
                    {kind === "tires" ? (
                      <>
                        <td className="px-3 py-3">{item.norm}</td>
                        <td className="px-3 py-3">{item.actual}</td>
                      </>
                    ) : (
                      <td className="px-3 py-3">{item.serviceLife}</td>
                    )}
                  </>
                ) : (
                  <>
                    <td className="px-3 py-3">{item.quantity}</td>
                    <td className="px-3 py-3">{item.installDate}</td>
                    <td className="px-3 py-3">{item.actual}</td>
                    <td className="px-3 py-3">{item.norm}</td>
                    <td className={cn("px-3 py-3", item.status === "expired" && "text-destructive")}>{item.remaining}</td>
                    <td className="px-3 py-3">
                      {item.status === "expired" && (
                        <span className="inline-flex rounded-full bg-destructive/10 px-2 py-1 text-xs text-destructive">
                          Срок превышен
                        </span>
                      )}
                      {item.status === "warning" && (
                        <span className="inline-flex rounded-full bg-warning-soft px-2 py-1 text-xs text-warning">
                          Требует внимания
                        </span>
                      )}
                      {item.status === "ok" && (
                        <span className="inline-flex rounded-full bg-success/10 px-2 py-1 text-xs text-success">
                          В норме
                        </span>
                      )}
                    </td>
                  </>
                )}
                <td className="px-3 py-3">{item.reason}</td>
              </tr>
            ))}
            {sortedData.length === 0 && (
              <tr>
                <td colSpan={config.columns.length + 1} className="py-10 text-center text-muted-foreground">
                  Записи не найдены
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
