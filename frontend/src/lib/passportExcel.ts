import type { PassportDataItem, Vehicle, VehicleType } from "./types";

// Electronic passport (formulyar) template — 120 columns, header on sheet row 7,
// numbering row on row 8, data from row 9 (0-based indexes 6 / 7 / 8).
// Column indexes below are 0-based positions inside the header row.

export const PASSPORT_HEADERS: string[] = [
  "№ п/п",
  "Подразделение",
  "Марка машины",
  "Год выпуска",
  "Дата ввода в эксплуатацию",
  "Наряд на получение (передачу) ВВСТ",
  "Государственный регистрационный знак (строевой номер)",
  "Группа эксплуатации",
  "Закрепленный водитель",
  "Расположение",
  "Техническое состояние",
  "Дата поломки",
  "Характер неисправности",
  "Серия и номер паспорта (формуляра)",
  "СРТС",
  "Диагностическая карта техсостояния (срок действия)",
  "Страховой полис ОСАГО (срок действия)",
  "Заводской номер машины",
  "Идентификационный номер (VIN)",
  "Шасси №",
  "Кузов №",
  "Кабина №",
  "Кунг №",
  "Корпус №",
  "Башня №",
  "Марка двигателя",
  "Номер двигателя",
  "Специальное оборудование № 1 (марка, тип, номер)",
  "Специальное оборудование № 2 (марка, тип, номер)",
  "Марка пушки (орудия)",
  "Номер пушки",
  "Настрел пушки",
  "Марка автоматич. пушки",
  "Номер автоматич. пушки",
  "Настрел автоматич. пушки",
  "Марка зенитного пулемета",
  "Номер зенитного пулемета",
  "Настрел зенитного пулемета",
  "Марка пулемета № 1",
  "Номер пулемета № 1",
  "Настрел пулемета № 1",
  "Марка пулемета № 2",
  "Номер пулемета № 2",
  "Настрел пулемета № 2",
  "Марка пулемета № 3",
  "Номер пулемета № 3",
  "Настрел пулемета № 3",
  "Марка радиостанции",
  "Номер радиостанции",
  "Марка АКБ",
  "Завод изготовитель АКБ",
  "Количество АКБ",
  "Номер АКБ",
  "Дата изготовления АКБ",
  "Дата приведения (установки) АКБ",
  "Срок службы АКБ",
  "Отметка о списании АКБ",
  "Марка дополнительн. АКБ",
  "Завод изготовитель дополнительн. АКБ",
  "Количество дополнительн. АКБ",
  "Номер дополнительн. АКБ",
  "Дата изготовления дополнительн. АКБ",
  "Дата приведения (установки) дополнительн. АКБ",
  "Срок службы дополнительн. АКБ",
  "Отметка о списании дополнительн. АКБ",
  "Марка, модель и размер шин (гусениц)",
  "Количество шин (гусениц)",
  "Номера шин (гусениц)",
  "Дата установки шин (гусениц)",
  "Показания спидометра при которых установлены шины (гусеницы), км",
  "Норма наработки шин (гусениц) до списания",
  "Остаток ресурса шин (гусениц) до списания, км",
  "Отметка о списании ШИН (гусениц)",
  "Марка, модель и размер дополнит. шин",
  "Количество дополнит. шин",
  "Номера дополнит. шин",
  "Дата установки дополнит. шин",
  "Показания спидометра при которых установлены дополнит. шины, км",
  "Норма наработки дополнит. шин до списания, км",
  "Остаток ресурса дополнит. шин до списания, км",
  "Отметка о списании дополнит. шин",
  "Дата установки ТЕНТА грузовой платформы",
  "Срок службы ТЕНТА",
  "Отметка о списании ТЕНТА",
  "Дата установки БРЕЗЕНТА",
  "Срок службы БРЕЗЕНТА",
  "Отметка о списании БРЕЗЕНТА",
  "Дата установки ТШ-З",
  "Срок службы ТШ-З",
  "Отметка о списании ТШ-З",
  "Дата установки ТШ-Л",
  "Срок службы ТШ-Л",
  "Отметка о списании ТШ-Л",
  "Наработка машины с начала эксплуатации на 01.12.2025 г.",
  "Показания спидометра на 01.12.2025 г.",
  "Текущие показания СПИДОМЕТРА",
  "Наработка машины с начала года, км",
  "Наработка машины с начала эксплуатации на текущую дату, км",
  "Годовая норма, км",
  "Остаток годовай нормы, км",
  "Наработка МОТОЧАСОВ с начала эксплуатации на 01.12.2025 г.",
  "Показания МОТОЧАСОВ на 01.12.2025 г.",
  "Текущие показания МОТОЧАСОВ",
  "Наработка МОТОЧАСОВ с начала года",
  "Наработка МОТОЧАСОВ с начала эксплуатации на текущую дату",
  "Годовая норма МОТОЧАСОВ",
  "Остаток годовай нормы МОТОЧАСОВ",
  "Значение коэффициента корректирования",
  "Норма наработки на списание машины, км",
  "Скорректированная норма наработки на списание машины, км",
  "Норма наработки до КР, км",
  "Скорректированная норма наработки до КР",
  "Норма наработки до СР, км",
  "Запас ресурса до очередного ремонта, км",
  "Вид последнего номерного ТО",
  "Дата проведения последнего ТО",
  "Показания спидометра при проведении последнего ТО, км",
  "Норма наработки на ТО, км",
  "Наработка от последнего ТО, км",
  "Запас ресурса до очередного ТО, км",
];

export const PASSPORT_COLUMN_COUNT = PASSPORT_HEADERS.length;

// 0-based excel column indexes mapped onto Vehicle scalar fields.
const COL = {
  unit: 1,
  brand: 2,
  year: 3,
  commissionDate: 4,
  order: 5,
  plate: 6,
  group: 7,
  assignedTo: 8,
  location: 9,
  techState: 10,
  breakdownReason: 12,
  mileageAtDec1: 93,
  speedometerAtDec1: 94,
  mileage: 95,
  yearMileage: 96,
  totalMileage: 97,
  yearlyNorm: 98,
  motoHoursAtDec1: 100,
  motoHoursDec1: 101,
  motoHours: 102,
  yearMotoHours: 103,
  totalMotoHours: 104,
  yearlyMotoNorm: 105,
} as const;

const MAPPED_INDEXES = new Set<number>(Object.values(COL));

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function cellText(row: unknown[], index: number): string {
  const v = row[index];
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function toInt(v: string): number {
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toNumber(v: string): number {
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function statusFromTechState(text: string): Vehicle["status"] {
  const t = norm(text);
  if (t.includes("ремонт")) return "repair";
  if (t.includes("недоступ") || t.includes("списан")) return "unavailable";
  return "ready";
}

function statusToTechState(status: Vehicle["status"]): string {
  if (status === "repair") return "в ремонте";
  if (status === "unavailable") return "недоступна";
  return "исправен";
}

function guessType(brand: string): VehicleType {
  if (/[ТТББММ][- ]?\d|БМП|БТР|МТ-?ЛБ|ПТМ/i.test(brand)) return "tracked";
  return "auto";
}

async function readSheetRows(file: File): Promise<unknown[][]> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const book = XLSX.read(buf);
  const first = book.SheetNames[0];
  if (!first) return [];
  const sheet = book.Sheets[first];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false });
}

function findHeaderRow(rows: unknown[][]): number {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = rows[i] ?? [];
    const hasUnit = row.some((c) => norm(String(c ?? "")) === "подразделение");
    const hasBrand = row.some((c) => norm(String(c ?? "")) === "марка машины");
    if (hasUnit && hasBrand) return i;
  }
  return -1;
}

/** Parse the electronic-passport xlsx into Vehicle objects (unmapped columns kept in passportExtra). */
export async function importPassportExcel(file: File, baseId: number): Promise<Vehicle[]> {
  const rows = await readSheetRows(file);
  const headerRow = findHeaderRow(rows);
  if (headerRow < 0) return [];

  // Skip the № numbering row if present (all-numeric cells).
  let dataStart = headerRow + 1;
  const maybeNumbers = rows[dataStart] ?? [];
  const nonEmpty = maybeNumbers.filter((c) => String(c ?? "").trim() !== "");
  if (nonEmpty.length > 0 && nonEmpty.every((c) => /^\d+$/.test(String(c).trim()))) {
    dataStart += 1;
  }

  const vehicles: Vehicle[] = [];
  let nextId = baseId;
  for (let r = dataStart; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const brand = cellText(row, COL.brand);
    const plate = cellText(row, COL.plate);
    if (!brand && !plate) continue;

    const passportExtra: PassportDataItem[] = [];
    for (let i = 0; i < PASSPORT_COLUMN_COUNT; i++) {
      if (MAPPED_INDEXES.has(i)) continue;
      const value = cellText(row, i);
      if (value === "") continue;
      passportExtra.push({ value, column: i + 1, header: PASSPORT_HEADERS[i] });
    }

    const unit = cellText(row, COL.unit) || cellText(row, COL.location);
    vehicles.push({
      id: nextId++,
      unit,
      brand,
      year: toInt(cellText(row, COL.year)) || new Date().getFullYear(),
      commissionDate: cellText(row, COL.commissionDate),
      order: cellText(row, COL.order),
      plate,
      group: cellText(row, COL.group) || "УЧ",
      assignedTo: cellText(row, COL.assignedTo),
      type: guessType(brand),
      status: statusFromTechState(cellText(row, COL.techState)),
      statusReason: cellText(row, COL.breakdownReason),
      mileage: toInt(cellText(row, COL.mileage)),
      motoHours: toNumber(cellText(row, COL.motoHours)),
      details: {},
      passportExtra,
    });
  }
  return vehicles;
}

function passportLookup(vehicle: Vehicle): Map<number, string> {
  const map = new Map<number, string>();
  for (const item of vehicle.passportExtra ?? []) {
    if (item.value === null || item.value === "") continue;
    const s = String(item.value);
    if (!map.has(item.column)) map.set(item.column, s);
  }
  return map;
}

/** Passport column values (0-based array of PASSPORT_COLUMN_COUNT cells) for one vehicle. */
export function vehicleToPassportRow(vehicle: Vehicle, yearlyNorm: number, index: number): unknown[] {
  const extra = passportLookup(vehicle);
  const row: unknown[] = new Array(PASSPORT_COLUMN_COUNT).fill("");
  const put = (col: number, value: string | number) => {
    if (value !== "" && value !== null && value !== undefined) row[col] = value;
  };

  row[0] = index + 1;
  put(COL.unit, vehicle.unit);
  put(COL.brand, vehicle.brand);
  put(COL.year, vehicle.year);
  put(COL.commissionDate, vehicle.commissionDate);
  put(COL.order, vehicle.order);
  put(COL.plate, vehicle.plate);
  put(COL.group, vehicle.group);
  put(COL.assignedTo, vehicle.assignedTo);
  put(COL.techState, statusToTechState(vehicle.status));
  if (vehicle.statusReason) put(COL.breakdownReason, vehicle.statusReason);
  put(COL.mileageAtDec1, vehicle.rawDto?.mileageAtDec1 ?? vehicle.mileage);
  put(COL.mileage, vehicle.mileage);
  put(COL.yearlyNorm, vehicle.rawDto?.yearlyNorm ?? yearlyNorm);
  put(COL.motoHours, vehicle.motoHours);

  for (let i = 0; i < PASSPORT_COLUMN_COUNT; i++) {
    if (MAPPED_INDEXES.has(i) || row[i] !== "") continue;
    const value = extra.get(i + 1);
    if (value !== undefined) row[i] = value;
  }
  return row;
}

/** Build the aoa rows for the electronic-passport template (headers + optional data rows). */
export function buildPassportSheetRows(vehicles: Vehicle[], yearlyNorm: number): unknown[][] {
  const today = new Date();
  const dateStr = today.toLocaleDateString("ru-RU");
  const rows: unknown[][] = [
    [],
    [],
    ["", `ИСКУСТВЕННЫЙ ИНТЕЛЕКТ АВТОМОБИЛЬНОЙ СЛУЖБЫ НА ${dateStr}`],
    ["", "ЭЛЕКТРОННЫЙ ПАСПОРТ (ФОРМУЛЯР) МАШИНЫ АВТОМОБИЛЬНОЙ ТЕХНИКИ"],
    [],
    [],
    PASSPORT_HEADERS.slice(),
    Array.from({ length: PASSPORT_COLUMN_COUNT }, (_, i) => i + 1),
  ];

  vehicles.forEach((v, idx) => {
    rows.push(vehicleToPassportRow(v, yearlyNorm, idx));
  });

  return rows;
}

export async function exportPassportExcel(filename: string, vehicles: Vehicle[], yearlyNorm: number) {
  const XLSX = await import("xlsx");
  const sheet = XLSX.utils.aoa_to_sheet(buildPassportSheetRows(vehicles, yearlyNorm));
  sheet["!cols"] = PASSPORT_HEADERS.map(() => ({ wch: 18 }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Электронный паспорт");
  XLSX.writeFile(book, filename);
}
