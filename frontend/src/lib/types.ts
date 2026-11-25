export type VehicleStatus = "ready" | "repair" | "unavailable";
export type VehicleType = "auto" | "tracked" | "snow" | "other";

// Wire format of a passportData entry (backend VehicleDTO).
export interface PassportDataItem {
  value: string | number | boolean | null;
  column: number;
  header: string;
  ordinal?: number;
  calculation?: unknown;
}

// Wire format of backend VehicleDTO (backend/server.py). Vehicles carry their
// unmapped passport fields verbatim in `passportExtra` and the untouched
// original payload in `rawDto` so saving never loses backend-side data.
export interface VehicleDto {
  id: number;
  brand: string;
  regNumber: string;
  usageType: string;
  driver: string;
  location: string;
  mileageAtDec1: number;
  currentMileage: number;
  yearlyNorm: number;
  maintenanceInfo: { text: string; status: "ok" | "warn" | "danger" };
  batteryStatus: "ok" | "none" | "warn" | "danger";
  tireStatus: "ok" | "none" | "warn" | "danger";
  hasCertificate: boolean;
  hasHistory: boolean;
  passportData?: PassportDataItem[];
}

export interface Vehicle {
  id: number;
  unit: string;
  brand: string;
  year: number;
  commissionDate: string;
  order: string;
  plate: string;
  group: string;
  assignedTo: string;
  type: VehicleType;
  status: VehicleStatus;
  statusReason: string;
  mileage: number;
  motoHours: number;
  details: Record<string, string>;
  passportExtra?: PassportDataItem[];
  rawDto?: VehicleDto;
}

export interface Trip {
  id: string;
  vehicleId: number;
  date: string; // YYYY-MM-DD
  km: number;
  hours: number;
  note: string;
}

export interface JournalRow {
  id: string;
  date: string;
  unit: string;
  driver: string;
  waybill: string;
  brand: string;
  plate: string;
  techState: string;
  speedometer: string;
  odometerOut: string;
  departTime: string;
  odometerIn: string;
  returnTime: string;
  dutyOfficer: string;
}

export type ScheduleKind = "oup" | "household" | "other";

export interface ScheduleEvent {
  id: string;
  kind: ScheduleKind;
  name: string;
  place: string;
  brands: string;
  teacher: string;
  start: string;
  end: string;
}

export interface WorkOrder {
  id: string;
  number: string;
  date: string;
  vehicleIds: string[];
  purpose: string;
  senior: string;
}

export type WriteOffKind = "akb" | "tires" | "headsets" | "tarps";

export interface WriteOff {
  id: string;
  kind: WriteOffKind;
  date: string;
  vehicleId: number;
  item: string;
  quantity: number;
  reason: string;
}

export interface AppSettings {
  toIntervalKm: number;
}

export interface AppState {
  vehicles: Vehicle[];
  trips: Trip[];
  journal: JournalRow[];
  events: ScheduleEvent[];
  orders: WorkOrder[];
  writeOffs: WriteOff[];
  settings: AppSettings;
}

export const CARD_FIELDS = [
  "Марка машины",
  "Паспорт (формуляр) машины",
  "Заводской номер",
  "Идентификационный номер (VIN)",
  "Номер шасси",
  "Номер кузова",
  "Номер кабины",
  "Номер кунга",
  "Номер корпуса",
  "Номер башни",
  "Марка двигателя",
  "Номер двигателя",
  "Специальное оборудование (марка, тип, номер)",
  "Марка пушки (орудия)",
  "Год выпуска",
  "Дата ввода в эксплуатацию",
  "Государственный регистрационный знак",
  "Подразделение",
  "Группа эксплуатации",
  "Закреплённый водитель",
] as const;

export const ABSENT = "ОТСУТСТВУЕТ";
