// Client for the Military Planner backend (Python http.server + PostgreSQL).
// In dev the Vite server proxies /api to http://127.0.0.1:8000; in the
// packaged app the backend serves the frontend itself, so paths are relative.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    if (response.status === 401) {
      throw new AuthError();
    }
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return payload as T;
}

export class AuthError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "AuthError";
  }
}

export function apiHealth() {
  return request<{ status: string }>("GET", "/api/health");
}

export function apiGetCollection<T = unknown>(name: string) {
  return request<T[]>("GET", `/api/${name}`);
}

export function apiPutCollection<T = unknown>(name: string, items: unknown[]) {
  return request<T[]>("PUT", `/api/${name}`, items);
}

export type AccessScope = "orders" | "passport" | "general";

export interface AccessStatus {
  configured: boolean;
  authenticated: boolean;
}

export function apiAccessStatus(scope: AccessScope) {
  return request<AccessStatus>("GET", `/api/access/${scope}`);
}

export function apiAccessLogin(scope: AccessScope, password: string) {
  return request<AccessStatus>("POST", `/api/access/${scope}/login`, { password });
}

export function apiAccessSetup(scope: AccessScope, password: string) {
  return request<AccessStatus>("POST", `/api/access/${scope}/setup`, { password });
}

export function apiAccessLogout(scope: AccessScope) {
  return request<AccessStatus>("POST", `/api/access/${scope}/logout`, {});
}

export function apiGetVehicleDetails(vehicleId: number): Promise<VehicleDetails> {
  return request<VehicleDetails[]>("GET", "/api/vehicle-details").then((items) => {
    const item = items.find((d) => d.vehicleId === vehicleId);
    if (!item) {
      throw new ApiError(404, "Vehicle details not found");
    }
    return item;
  });
}

export function apiPutVehicleDetails(vehicleId: number, data: VehicleDetails): Promise<VehicleDetails> {
  return request<VehicleDetails[]>("GET", "/api/vehicle-details").then((allItems) => {
    const filtered = allItems.filter((d) => d.vehicleId !== vehicleId);
    const updated = [...filtered, { ...data, vehicleId }];
    return request<VehicleDetails[]>("PUT", "/api/vehicle-details", updated).then((items) => {
      const item = items.find((d) => d.vehicleId === vehicleId);
      if (!item) {
        throw new ApiError(404, "Vehicle details not found after save");
      }
      return item;
    });
  });
}

export interface VehicleDetails {
  vehicleId: number;
  certificate: Certificate | null;
  batteries: Battery[];
  tires: Tire[];
  maintenance: Maintenance[];
  history: History[];
}

export interface Certificate {
  type: "AT" | "BT";
  brandModel: string;
  regNumber: string;
  issuedBy: string;
  issueDate: string;
  vin?: string;
  chassisNumber?: string;
  bodyNumber?: string;
  hullNumber?: string;
  cabinNumber?: string;
  kungNumber?: string;
  turretNumber?: string;
  engineNumber?: string;
  engineBrand?: string;
  enginePower?: number;
  engineDisplacement?: number;
  transmissionNumber?: string;
  factoryNumber?: string;
  yearOfManufacture?: number;
  maxMass?: number;
  unladenMass?: number;
  color?: string;
  vehicleType?: string;
  usageGroup?: string;
  subdivision?: string;
  weapons: Weapon[];
  extraFields: ExtraField[];
  individualCardFields?: Record<string, string>;
}

export interface Weapon {
  id: number;
  type: "Пушка" | "Пулемет" | "Радиостанция" | "Другое";
  model: string;
  number: string;
  quantity: number;
}

export interface ExtraField {
  id: number;
  name: string;
  value: string;
}

export interface Battery {
  id: number;
  brand: string;
  number: string;
  installDate: string;
  serviceLifeYears: number;
}

export interface Tire {
  id: number;
  size: string;
  brand: string;
  model: string;
  normKm: number;
  season: "Зима" | "Лето" | "Всесезонная";
  quantity: number;
  installDate: string;
  serialNumbers: string;
  mileageAtInstall: number;
}

export interface Maintenance {
  id: number;
  typeName: string;
  intervalKm: number;
  intervalDays: number;
  lastDate: string | null;
  lastMileage: number | null;
  isActive: boolean;
}

export interface History {
  id: number;
  date: string;
  description: string;
}

export interface ScheduleItem {
  id: number;
  date: string;
  title: string;
  location: string;
  route?: string;
  requiredBrand: string;
  requiredQuantity: number;
  startTime: string;
  endTime: string;
  instructor: string;
  teacher?: string;
  scheduleRowId?: number;
  scheduleDates?: string[];
}
