import { useMemo, useState } from "react";
import { ArrowUpDown, Download } from "lucide-react";
import { Button, Input, PageHeader, Panel, StatCard } from "@/components/ui-kit";
import { useAppState } from "@/lib/store";
import type { Vehicle } from "@/lib/types";
import { cn } from "@/lib/utils";

type WriteOffKind = "akb" | "tires" | "headsets" | "tarps";

// Passport column numbers (1-based, as stored in passportExtra.column).
const PC = {
  factoryNumber: 18,
  vin: 19,
  akbBrand: 50,
  akbMaker: 51,
  akbQty: 52,
  akbNumber: 53,
  akbMade: 54,
  akbInstalled: 55,
  akbLife: 56,
  akbWritten: 57,
  akb2Brand: 58,
  akb2Maker: 59,
  akb2Qty: 60,
  akb2Number: 61,
  akb2Made: 62,
  akb2Installed: 63,
  akb2Life: 64,
  akb2Written: 65,
  tireSpec: 66,
  tireQty: 67,
  tireNumbers: 68,
  tireInstalled: 69,
  tireOdometer: 70,
  tireNorm: 71,
  tireRemaining: 72,
  tireWritten: 73,
  tire2Spec: 74,
  tire2Qty: 75,
  tire2Numbers: 76,
  tire2Installed: 77,
  tire2Odometer: 78,
  tire2Norm: 79,
  tire2Remaining: 80,
  tire2Written: 81,
  tentInstalled: 82,
  tentLife: 83,
  tentWritten: 84,
  tarpInstalled: 85,
  tarpLife: 86,
  tarpWritten: 87,
  tsh3Installed: 88,
  tsh3Life: 89,
  tsh3Written: 90,
  tshLInstalled: 91,
  tshLLife: 92,
  tshLWritten: 93,
} as const;

function pv(vehicle: Vehicle, column: number): string {
  const item = vehicle.passportExtra?.find((p) => p.column === column);
  return item ? String(item.value ?? "").trim() : "";
}

function toInt(v: string): number {
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function parseDate(v: string): Date | null {
  const s = v.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return new Date(y, +m[2] - 1, +m[1]);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function yearsSince(dateStr: string, now: Date): number | null {
  const d = parseDate(dateStr);
  if (!d) return null;
  let years = now.getFullYear() - d.getFullYear();
  const before = now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate());
  if (before) years -= 1;
  return Math.max(0, years);
}

function fmtYears(years: number): string {
  return `${years} ${years === 1 ? "год" : years < 5 ? "года" : "лет"}`;
}

function normYears(text: string, fallback: number): number {
  const n = toInt(text);
  return n > 0 && n < 100 ? n : fallback;
}

function lifeStatus(actual: number | null, norm: number, writtenOff: string, now: Date): { actual: string; norm: string; remaining: string; status: WriteOffItem["status"]; reason: string } {
  if (writtenOff) {
    return { actual: actual === null ? "—" : fmtYears(actual), norm: fmtYears(norm), remaining: "списано", status: "expired", reason: writtenOff };
  }
  if (actual === null) {
    return { actual: "—", norm: fmtYears(norm), remaining: "—", status: "ok", reason: "—" };
  }
  const left = norm - actual;
  if (left < 0) {
    return { actual: fmtYears(actual), norm: fmtYears(norm), remaining: `просрочено на ${fmtYears(-left)}`, status: "expired", reason: `Срок службы превышен (${fmtYears(norm)})` };
  }
  if (left <= 1) {
    return { actual: fmtYears(actual), norm: fmtYears(norm), remaining: `менее ${fmtYears(1)}`, status: "warning", reason: "Срок истекает" };
  }
  return { actual: fmtYears(actual), norm: fmtYears(norm), remaining: fmtYears(left), status: "ok", reason: "—" };
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

function buildItems(kind: WriteOffKind, vehicles: Vehicle[]): WriteOffItem[] {
  const now = new Date();
  const items: WriteOffItem[] = [];
  let id = 1;

  const base = (v: Vehicle) => ({
    vehicle: v.brand,
    vehiclePlate: v.plate,
    vehicleId: pv(v, PC.factoryNumber) || pv(v, PC.vin),
  });

  for (const v of vehicles) {
    if (kind === "akb") {
      for (const [suffix, detail] of [["", "Основная"], ["2", "Дополнительная"]] as const) {
        const p = suffix === "" ? PC.akbBrand : PC.akb2Brand;
        const brand = pv(v, p);
        const written = pv(v, suffix === "" ? PC.akbWritten : PC.akb2Written);
        const installed = pv(v, suffix === "" ? PC.akbInstalled : PC.akb2Installed);
        if (!brand && !written) continue;
        const life = normYears(pv(v, (suffix === "" ? PC.akbLife : PC.akb2Life) as number), 0);
        const actualYears = yearsSince(installed, now);
        const lifeInfo = life > 0 ? lifeStatus(actualYears, life, written, now) : { actual: "—", norm: pv(v, (suffix === "" ? PC.akbLife : PC.akb2Life) as number) || "—", remaining: "—", status: written ? ("expired" as const) : ("ok" as const), reason: written || "—" };
        items.push({
          ...base(v),
          id: id++,
          item: brand || "АКБ",
          itemDetail: detail,
          quantity: toInt(pv(v, (suffix === "" ? PC.akbQty : PC.akb2Qty) as number)) || 1,
          numbers: pv(v, (suffix === "" ? PC.akbNumber : PC.akb2Number) as number) || pv(v, (suffix === "" ? PC.akbMaker : PC.akb2Maker) as number),
          installDate: installed || pv(v, (suffix === "" ? PC.akbMade : PC.akb2Made) as number),
          serviceLife: lifeInfo.norm,
          norm: lifeInfo.norm,
          actual: lifeInfo.actual,
          remaining: lifeInfo.remaining,
          status: lifeInfo.status,
          reason: lifeInfo.reason,
        });
      }
    } else if (kind === "tires") {
      for (const [suffix, detail] of [["", "Основная"], ["2", "Дополнительная"]] as const) {
        const p = suffix === "" ? PC.tireSpec : PC.tire2Spec;
        const spec = pv(v, p);
        const written = pv(v, suffix === "" ? PC.tireWritten : PC.tire2Written);
        if (!spec && !written) continue;
        const installKm = toInt(pv(v, (suffix === "" ? PC.tireOdometer : PC.tire2Odometer) as number));
        const normKm = toInt(pv(v, (suffix === "" ? PC.tireNorm : PC.tire2Norm) as number));
        const fileRemaining = pv(v, (suffix === "" ? PC.tireRemaining : PC.tire2Remaining) as number);
        const actualKm = installKm > 0 ? Math.max(0, v.mileage - installKm) : 0;
        const remainingKm = toInt(fileRemaining) || (normKm > 0 ? normKm - actualKm : 0);
        const status: WriteOffItem["status"] = written || remainingKm < 0 ? "expired" : remainingKm < normKm * 0.2 ? "warning" : "ok";
        items.push({
          ...base(v),
          id: id++,
          item: spec || "Шины",
          itemDetail: detail,
          quantity: toInt(pv(v, (suffix === "" ? PC.tireQty : PC.tire2Qty) as number)) || 1,
          numbers: pv(v, (suffix === "" ? PC.tireNumbers : PC.tire2Numbers) as number),
          installDate: pv(v, (suffix === "" ? PC.tireInstalled : PC.tire2Installed) as number),
          serviceLife: normKm ? `${normKm.toLocaleString("ru-RU")} км` : "—",
          norm: normKm ? normKm.toLocaleString("ru-RU") : "—",
          actual: actualKm ? actualKm.toLocaleString("ru-RU") : "—",
          remaining: written ? "списано" : remainingKm < 0 ? `просрочено на ${Math.abs(remainingKm).toLocaleString("ru-RU")} км` : remainingKm.toLocaleString("ru-RU"),
          status,
          reason: written || (remainingKm < 0 ? `Пробег превышен (${(normKm + Math.abs(remainingKm)).toLocaleString("ru-RU")} км)` : status === "warning" ? "Остаток ресурса менее 20%" : "—"),
        });
      }
    } else if (kind === "headsets") {
      for (const [name, installedCol, lifeCol, writtenCol, norm] of [
        ["ТШ-З", PC.tsh3Installed, PC.tsh3Life, PC.tsh3Written, 6],
        ["ТШ-Л", PC.tshLInstalled, PC.tshLLife, PC.tshLWritten, 5],
      ] as const) {
        const installed = pv(v, installedCol);
        const written = pv(v, writtenCol);
        if (!installed && !written) continue;
        const fileLife = normYears(pv(v, lifeCol), norm);
        const actualYears = yearsSince(installed, now);
        const info = lifeStatus(actualYears, fileLife, written, now);
        items.push({
          ...base(v),
          id: id++,
          item: name,
          quantity: 1,
          installDate: installed,
          serviceLife: info.norm,
          norm: info.norm,
          actual: info.actual,
          remaining: info.remaining,
          status: info.status,
          reason: info.reason,
        });
      }
    } else {
      for (const [name, installedCol, lifeCol, writtenCol, fallback] of [
        ["Тент", PC.tentInstalled, PC.tentLife, PC.tentWritten, v.type === "tracked" ? 6 : 5],
        ["Брезент", PC.tarpInstalled, PC.tarpLife, PC.tarpWritten, v.type === "tracked" ? 6 : 5],
      ] as const) {
        const installed = pv(v, installedCol);
        const written = pv(v, writtenCol);
        if (!installed && !written) continue;
        const fileLife = normYears(pv(v, lifeCol), fallback);
        const actualYears = yearsSince(installed, now);
        const info = lifeStatus(actualYears, fileLife, written, now);
        items.push({
          ...base(v),
          id: id++,
          item: name,
          quantity: 1,
          installDate: installed,
          serviceLife: info.norm,
          norm: info.norm,
          actual: info.actual,
          remaining: info.remaining,
          status: info.status,
          reason: info.reason,
        });
      }
    }
  }
  return items;
}

export function WriteOffPage({ kind, title, itemLabel }: WriteOffPageProps) {
  const config = PAGE_CONFIG[kind];
  const vehicles = useAppState((s) => s.vehicles);
  const data = useMemo(() => buildItems(kind, vehicles), [kind, vehicles]);
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
        {(() => {
          const expired = data.filter((i) => i.status === "expired");
          const expiredVehicles = new Set(expired.map((i) => i.vehiclePlate)).size;
          const cards =
            kind === "akb" || kind === "tires"
              ? [
                  { label: kind === "akb" ? "МАШИН ТРЕБУЮТ ЗАМЕНЫ АКБ" : "МАШИН ТРЕБУЮТ ЗАМЕНЫ ШИН", value: expiredVehicles },
                  { label: kind === "akb" ? "ГРУПП АККУМУЛЯТОРОВ" : "ГРУПП ШИН", value: data.length },
                ]
              : [
                  { label: "ПОЗИЦИЙ В ПАСПОРТАХ", value: data.length },
                  { label: "ПОДЛЕЖАТ СПИСАНИЮ", value: expired.length },
                  { label: "МАШИН С ПРОСРОЧЕННЫМ ИМУЩЕСТВОМ", value: expiredVehicles },
                ];
          return cards.map((card, idx) => <StatCard key={idx} label={card.label} value={card.value} />);
        })()}
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
