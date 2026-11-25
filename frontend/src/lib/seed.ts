import type { AppState, JournalRow, Trip, Vehicle, VehicleType } from "./types";

type Raw = [string, string, number, string, string, VehicleType, number, string?];

const UBM = "1 АО (учебное) отдела (УБМ)";
const UBT = "1 Отд (УБТ) отдела (УБМ)";

const RAW: Raw[] = [
  ["УАЗ-3163-103-61", "5349 АК 76 RUS", 2015, "УЧ", "ст. с-т Щеголев А.В.", "auto", 41250, "01.01.2026"],
  ["УАЗ-3163-103-61", "5350 АК 76 RUS", 2015, "УЧ", "ст. с-т Щеголев А.В.", "auto", 39870],
  ["УАЗ-3163-187-31", "4732 АМ 76 RUS", 2022, "УЧ", "г.п. Строганов И.Е.", "auto", 12410],
  ["УАЗ-3163-187-31", "4733 АМ 76 RUS", 2022, "УЧ", "ст. с-т Щеголев А.В.", "auto", 11980],
  ["УАЗ-3163-187-31", "4734 АМ 76 RUS", 2022, "УЧ", "г.п. Строганов И.Е.", "auto", 13205],
  ["PTS001 БАРС", "4773 АМ 76 RUS", 2023, "УЧ", "ст. с-т Григорьев П.С.", "auto", 6420],
  ["КАМАЗ-6350", "5333 АК 76 RUS", 2007, "УЧ", "ст. с-т Горашков Д.Н.", "auto", 88430],
  ["АСН-233115 Тигр-М СпН", "5828 АК 76 RUS", 2019, "УЧ", "с-т Клют А.А.", "auto", 27310],
  ["АСН-233115 Тигр-М СпН", "5710 АК 76 RUS", 2019, "УЧ", "с-т Клют А.А.", "auto", 25890],
  ["СНЕГОХОД АРМЕЙСКИЙ ТТМ-1901-40", "2000 АВ 76", 2021, "СШ", "мл. с-т Ершов В.В.", "snow", 3120],
  ["СНЕГОХОД АРМЕЙСКИЙ А1", "1999 АВ 76", 2021, "СШ", "мл. с-т Ершов В.В.", "snow", 2870],
  ["МОТОВЕЗДЕХОД АРМЕЙСКИЙ", "1998 АВ 76", 2020, "СШ", "ряд. Лопатин К.О.", "other", 1940],
  ["АЦ-8 на МАЗ-5334", "5208 АК 76 RUS", 1989, "УЧ", "ст. с-т Иванов С.П.", "auto", 85201],
  ["Т-80БВМ", "110", 2018, "УЧ", "ст. с-т Федоров Р.А.", "tracked", 2570],
  ["Т-14", "122", 2021, "УЧ", "с-т Беляев М.И.", "tracked", 1802],
  ["Т-72Б3", "131", 2016, "УЧ", "с-т Носов Е.Г.", "tracked", 3410],
  ["БМП-3", "214", 2014, "УЧ", "мл. с-т Котов А.Р.", "tracked", 4120],
  ["БТР-82А", "305", 2017, "УЧ", "с-т Яковлев Д.С.", "auto", 18750],
  ["Урал-4320", "6012 АК 76 RUS", 2011, "УЧ", "ряд. Морозов И.А.", "auto", 64320],
  ["Урал-4320", "6013 АК 76 RUS", 2011, "УЧ", "ряд. Осипов Н.В.", "auto", 61980],
  ["КАМАЗ-43118", "6120 АМ 76 RUS", 2016, "УЧ", "мл. с-т Зуев Л.Л.", "auto", 52440],
  ["КАМАЗ-5350", "6121 АМ 76 RUS", 2018, "УЧ", "с-т Гусев О.Ф.", "auto", 47610],
  ["ГАЗ-66", "4410 АВ 76 RUS", 1992, "УЧ", "ряд. Тихонов С.К.", "auto", 92310],
  ["ЗИЛ-131", "4411 АВ 76 RUS", 1990, "УЧ", "ряд. Сидоров Ю.Ю.", "auto", 97840],
  ["МТ-ЛБ", "402", 2009, "УЧ", "с-т Карпов В.Б.", "tracked", 5210],
];

const DETAIL_SAMPLES: Record<string, Partial<Record<string, string>>> = {
  "5350 АК 76 RUS": {
    "Паспорт (формуляр) машины": "АЕ № 031127",
    "Идентификационный номер (VIN)": "XTT316300F1030621",
    "Номер шасси": "316300F0523971",
    "Номер кузова": "316300F1030621",
    "Марка двигателя": "ЗМЗ 409050",
    "Номер двигателя": "F3027608",
  },
};

function vehicleFrom(raw: Raw, index: number): Vehicle {
  const [brand, plate, year, group, assignedTo, type, mileage, commission] = raw;
  const unit = type === "tracked" ? UBT : UBM;
  const sample = DETAIL_SAMPLES[plate] ?? {};
  const details: Record<string, string> = {
    "Паспорт (формуляр) машины": `АЕ № ${(31000 + index * 37).toString().padStart(6, "0")}`,
    "Марка двигателя": type === "tracked" ? "В-84" : type === "snow" ? "BRP 600" : "ЯМЗ-238",
    "Номер двигателя": `F${3027000 + index * 113}`,
  };
  for (const [key, value] of Object.entries(sample)) {
    if (value) details[key] = value;
  }
  return {
    id: index + 1,
    unit,
    brand,
    year,
    commissionDate: commission ?? "",
    order: commission ? "Наряд № 3026/БЭ-ЦВО от 01.01.2026 г." : "",
    plate,
    group,
    assignedTo,
    type,
    status: "ready",
    statusReason: "",
    mileage,
    motoHours: type === "tracked" ? Math.round(mileage / 6) : 0,
    details,
  };
}

const JOURNAL: JournalRow[] = [
  { id: "j1", date: "2026-11-21", unit: UBT, driver: "", waybill: "", brand: "Т-80БВМ", plate: "110", techState: "ТИ", speedometer: "ОПЛ", odometerOut: "2570", departTime: "3750", odometerIn: "", returnTime: "", dutyOfficer: "" },
  { id: "j2", date: "2026-11-20", unit: UBT, driver: "", waybill: "", brand: "Т-14", plate: "122", techState: "ТИ", speedometer: "ОПЛ", odometerOut: "1802", departTime: "2050", odometerIn: "", returnTime: "", dutyOfficer: "" },
  { id: "j3", date: "2026-11-18", unit: UBM, driver: "Иванов", waybill: "1243", brand: "АЦ-8 на МАЗ-5334", plate: "5208 АК 76 RUS", techState: "ТИ", speedometer: "ОПЛ", odometerOut: "84718", departTime: "", odometerIn: "85201", returnTime: "", dutyOfficer: "" },
  { id: "j4", date: "2026-11-18", unit: UBM, driver: "", waybill: "", brand: "АЦ-8 на МАЗ-5334", plate: "5208 АК 76 RUS", techState: "ТИ", speedometer: "ОПЛ", odometerOut: "85201", departTime: "", odometerIn: "", returnTime: "", dutyOfficer: "" },
];

const TRIPS: Trip[] = [
  { id: "t1", vehicleId: 13, date: "2026-11-18", km: 483, hours: 0, note: "Путевой лист № 1243" },
  { id: "t2", vehicleId: 14, date: "2026-11-21", km: 38, hours: 7, note: "" },
  { id: "t3", vehicleId: 15, date: "2026-11-20", km: 26, hours: 6, note: "" },
];

export function createSeedState(): AppState {
  return {
    vehicles: RAW.map(vehicleFrom),
    trips: TRIPS,
    journal: JOURNAL,
    events: [],
    orders: [],
    writeOffs: [],
    settings: { toIntervalKm: 100000 },
  };
}
