import { useSyncExternalStore } from "react";
import { apiGetCollection, apiPutCollection } from "./api";
import { vehicleFromDto, vehicleToDto } from "./backendMap";
import type { VehicleDto } from "./types";
import { createSeedState } from "./seed";
import type { AppState, Vehicle } from "./types";

const STORAGE_KEY = "vvst-planning-state-v1";
const seed = createSeedState();
let state: AppState = seed;
let loaded = false;
let backendSynced = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) state = { ...seed, ...(JSON.parse(raw) as Partial<AppState>) };
  } catch {
    state = seed;
  }
}

function persist() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage full or blocked */
  }
}

export function getState(): AppState {
  load();
  return state;
}

export function setState(update: (prev: AppState) => AppState) {
  load();
  state = update(state);
  persist();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppState<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(getState()),
    () => selector(seed),
  );
}

export function uid(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function nextVehicleId(): number {
  const ids = getState().vehicles.map((v) => v.id);
  return ids.length ? Math.max(...ids) + 1 : 1;
}

/** Pull the vehicle list from the backend once per session (browser only). */
export async function syncVehiclesFromBackend(): Promise<boolean> {
  if (backendSynced || typeof window === "undefined") return backendSynced;
  backendSynced = true;
  try {
    const dtos = await apiGetCollection<VehicleDto>("vehicles");
    const vehicles = dtos.map(vehicleFromDto);
    setState((s) => ({ ...s, vehicles }));
    return true;
  } catch {
    backendSynced = false;
    return false;
  }
}

/** Persist the whole vehicle collection (backend replaces it atomically). */
export async function saveVehiclesToBackend(vehicles: Vehicle[]): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    const yearlyNorm = getState().settings.toIntervalKm;
    await apiPutCollection("vehicles", vehicles.map((v) => vehicleToDto(v, yearlyNorm)));
    return true;
  } catch {
    return false;
  }
}

/** Update vehicles in state, mirror to localStorage and push to the backend. */
export function updateVehicles(update: (prev: Vehicle[]) => Vehicle[]) {
  setState((s) => ({ ...s, vehicles: update(s.vehicles) }));
  void saveVehiclesToBackend(getState().vehicles);
}
