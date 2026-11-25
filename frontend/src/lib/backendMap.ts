import { ABSENT, type PassportDataItem, type Vehicle, type VehicleDto, type VehicleStatus, type VehicleType } from "./types";

// Maps the frontend Vehicle model onto the backend VehicleDTO.
//
// Frontend-only fields ride inside passportData under META_PREFIX headers.
// passportData items that do not belong to us are preserved verbatim in
// Vehicle.passportExtra and re-emitted on save; the untouched original DTO is
// kept in Vehicle.rawDto so scalar fields we do not model (yearlyNorm,
// batteryStatus, ...) survive a round-trip.

const META_PREFIX = "meta:";
const VEHICLE_TYPES: VehicleType[] = ["auto", "tracked", "snow", "other"];
const VEHICLE_STATUSES: VehicleStatus[] = ["ready", "repair", "unavailable"];

function maintenanceStatus(status: VehicleStatus): "ok" | "warn" | "danger" {
  if (status === "repair") return "danger";
  if (status === "unavailable") return "warn";
  return "ok";
}

export function vehicleToDto(vehicle: Vehicle, yearlyNorm: number): VehicleDto {
  const meta: Record<string, string | number> = {
    type: vehicle.type,
    year: vehicle.year,
    commissionDate: vehicle.commissionDate,
    order: vehicle.order,
    motoHours: vehicle.motoHours,
    status: vehicle.status,
    statusReason: vehicle.statusReason,
  };

  const foreign = vehicle.passportExtra ?? [];
  const maxColumn = foreign.reduce((max, item) => Math.max(max, item.column), 0);
  const passportData: PassportDataItem[] = [];
  let column = maxColumn + 1;
  for (const [key, value] of Object.entries(meta)) {
    passportData.push({ value, column: column++, header: META_PREFIX + key });
  }
  passportData.push(...foreign);

  const raw = vehicle.rawDto;
  return {
    id: vehicle.id,
    brand: vehicle.brand,
    regNumber: vehicle.plate,
    usageType: vehicle.group,
    driver: vehicle.assignedTo,
    location: vehicle.unit,
    mileageAtDec1: vehicle.mileage,
    currentMileage: vehicle.mileage,
    yearlyNorm: raw?.yearlyNorm ?? yearlyNorm,
    maintenanceInfo: { text: vehicle.statusReason, status: maintenanceStatus(vehicle.status) },
    batteryStatus: raw?.batteryStatus ?? "ok",
    tireStatus: raw?.tireStatus ?? "ok",
    hasCertificate: raw?.hasCertificate ?? Boolean(vehicle.details["Паспорт (формуляр) машины"]),
    hasHistory: raw?.hasHistory ?? true,
    passportData,
  };
}

export function vehicleFromDto(dto: VehicleDto): Vehicle {
  const meta = new Map<string, string | number | boolean | null>();
  const details: Record<string, string> = {};
  const passportExtra: PassportDataItem[] = [];
  for (const item of dto.passportData ?? []) {
    if (item.header.startsWith(META_PREFIX)) {
      meta.set(item.header.slice(META_PREFIX.length), item.value);
      continue;
    }
    passportExtra.push(item);
    if (item.value !== null && item.value !== "" && item.value !== ABSENT) {
      details[item.header] = String(item.value);
    }
  }
  const type = meta.get("type");
  const status = meta.get("status");
  return {
    id: dto.id,
    unit: dto.location,
    brand: dto.brand,
    year: Number(meta.get("year") ?? 0),
    commissionDate: String(meta.get("commissionDate") ?? ""),
    order: String(meta.get("order") ?? ""),
    plate: dto.regNumber,
    group: dto.usageType,
    assignedTo: dto.driver,
    type: VEHICLE_TYPES.includes(type as VehicleType) ? (type as VehicleType) : "auto",
    status: VEHICLE_STATUSES.includes(status as VehicleStatus) ? (status as VehicleStatus) : "ready",
    statusReason: String(meta.get("statusReason") ?? ""),
    mileage: dto.currentMileage,
    motoHours: Number(meta.get("motoHours") ?? 0),
    details,
    passportExtra,
    rawDto: dto,
  };
}
