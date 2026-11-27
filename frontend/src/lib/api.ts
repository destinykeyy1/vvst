// Client for the Military Planner backend (Python http.server + PostgreSQL).
// In dev the Vite server proxies /api to http://127.0.0.1:8000; in the
// packaged app the backend serves the frontend itself, so paths are relative.

import type { JournalEntry } from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const ACCESS_REQUEST_TIMEOUT_MS = 30_000;

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort();
  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener("abort", abort, { once: true });
  }
  if (options.timeoutMs !== undefined) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
  }

  const init: RequestInit = {
    method,
    credentials: "same-origin",
    signal: controller.signal,
  };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  try {
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
  } catch (error) {
    if (timedOut) {
      throw new ApiError(
        504,
        "Сервер не ответил за 30 секунд. Проверьте соединение и попробуйте ещё раз.",
      );
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", abort);
  }
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

export function apiJournalAction(action: unknown) {
  return request<JournalEntry[]>("POST", "/api/journal/actions", action);
}

export type AccessScope = "orders" | "passport" | "general";

export interface AccessStatus {
  configured: boolean;
  authenticated: boolean;
}

function accessRequestOptions(signal?: AbortSignal): RequestOptions {
  return signal
    ? { signal, timeoutMs: ACCESS_REQUEST_TIMEOUT_MS }
    : { timeoutMs: ACCESS_REQUEST_TIMEOUT_MS };
}

export function apiAccessStatus(scope: AccessScope, signal?: AbortSignal) {
  return request<AccessStatus>(
    "GET",
    `/api/access/${scope}`,
    undefined,
    accessRequestOptions(signal),
  );
}

export function apiAccessLogin(
  scope: AccessScope,
  password: string,
  signal?: AbortSignal,
) {
  return request<AccessStatus>(
    "POST",
    `/api/access/${scope}/login`,
    { password },
    accessRequestOptions(signal),
  );
}

export function apiAccessSetup(
  scope: AccessScope,
  password: string,
  signal?: AbortSignal,
) {
  return request<AccessStatus>(
    "POST",
    `/api/access/${scope}/setup`,
    { password },
    accessRequestOptions(signal),
  );
}

export function apiAccessLogout(scope: AccessScope, signal?: AbortSignal) {
  return request<AccessStatus>(
    "POST",
    `/api/access/${scope}/logout`,
    {},
    accessRequestOptions(signal),
  );
}

export function apiGetVehicleDetails(
  vehicleId: number,
): Promise<VehicleDetails> {
  return request<VehicleDetails[]>("GET", "/api/vehicle-details").then(
    (items) => {
      const item = items.find((d) => d.vehicleId === vehicleId);
      if (!item) {
        throw new ApiError(404, "Vehicle details not found");
      }
      return item;
    },
  );
}

export function apiPutVehicleDetails(
  vehicleId: number,
  data: VehicleDetails,
): Promise<VehicleDetails> {
  return request<VehicleDetails[]>("GET", "/api/vehicle-details").then(
    (allItems) => {
      const filtered = allItems.filter((d) => d.vehicleId !== vehicleId);
      const updated = [...filtered, { ...data, vehicleId }];
      return request<VehicleDetails[]>(
        "PUT",
        "/api/vehicle-details",
        updated,
      ).then((items) => {
        const item = items.find((d) => d.vehicleId === vehicleId);
        if (!item) {
          throw new ApiError(404, "Vehicle details not found after save");
        }
        return item;
      });
    },
  );
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

export function apiSaveMileage(state: {
  vehicles: unknown[];
  journal: unknown[];
  exploitation: unknown[];
}) {
  return request("PUT", "/api/mileage-sync", state);
}
