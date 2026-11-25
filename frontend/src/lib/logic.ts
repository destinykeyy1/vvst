import type { AppState, ScheduleEvent, Trip, Vehicle } from "./types";

export const SECTION_PASSWORD = "12345678";

export function checkPassword(input: string): boolean {
  return input === SECTION_PASSWORD;
}

export function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function computeStats(s: AppState, now: Date) {
  const total = s.vehicles.length;
  const repair = s.vehicles.filter((v) => v.status === "repair").length;
  const unavailable = s.vehicles.filter((v) => v.status === "unavailable").length;
  const ready = total - repair - unavailable;
  const mk = monthKey(now);
  const ordersThisMonth = s.orders.filter((o) => o.date.startsWith(mk)).length;
  const avgMileage = total ? Math.round(s.vehicles.reduce((a, v) => a + v.mileage, 0) / total) : 0;
  const needsAttention = s.vehicles.filter(
    (v) => v.status !== "ready" || v.mileage >= s.settings.toIntervalKm,
  );
  return {
    total,
    ready,
    repair,
    orders: s.orders.length,
    ordersThisMonth,
    avgMileage,
    needsAttention,
  };
}

export function monthTripStats(vehicles: Vehicle[], trips: Trip[], year: number, month: number) {
  const prefix = `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthTrips = trips.filter((t) => t.date.startsWith(prefix));
  const withTrips = new Set(monthTrips.map((t) => t.vehicleId));
  const km = monthTrips.reduce((a, t) => a + t.km, 0);
  const hours = monthTrips.reduce((a, t) => a + t.hours, 0);
  return {
    total: vehicles.length,
    withTrips: withTrips.size,
    km,
    hours,
    avgKm: withTrips.size ? Math.round(km / withTrips.size) : 0,
    monthTrips,
  };
}

/** Daily norm used to highlight unusual mileage in the history grid. */
export const DAILY_NORM_KM = 100;

export function mileageLevel(km: number): "normal" | "double" | "triple" {
  if (km >= DAILY_NORM_KM * 3) return "triple";
  if (km >= DAILY_NORM_KM * 2) return "double";
  return "normal";
}

export function eventCoversDay(e: ScheduleEvent, iso: string) {
  return e.start <= iso && iso <= (e.end || e.start);
}

export function eventsInMonth(events: ScheduleEvent[], year: number, month: number) {
  const first = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const last = `${year}-${String(month + 1).padStart(2, "0")}-${String(new Date(year, month + 1, 0).getDate()).padStart(2, "0")}`;
  return events.filter((e) => e.start <= last && (e.end || e.start) >= first);
}

export const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];
export const MONTHS_GEN = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];
export const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

export function isoDate(y: number, m: number, d: number) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function formatRuDate(iso: string) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}.${m}.${y}`;
}

export function formatNumber(n: number) {
  return n.toLocaleString("ru-RU");
}
