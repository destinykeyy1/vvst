import { describe, expect, it } from "vitest";
import { checkPassword, computeStats, eventsInMonth, mileageLevel, monthTripStats } from "./logic";
import { createSeedState } from "./seed";

describe("section password", () => {
  it("accepts only the configured password", () => {
    expect(checkPassword("12345678")).toBe(true);
    expect(checkPassword("1234567")).toBe(false);
  });
});

describe("statistics", () => {
  it("ready count excludes vehicles in repair and unavailable", () => {
    const s = createSeedState();
    s.vehicles[0]!.status = "repair";
    s.vehicles[1]!.status = "unavailable";
    const stats = computeStats(s, new Date(2026, 10, 24));
    expect(stats.total).toBe(25);
    expect(stats.ready).toBe(23);
    expect(stats.repair).toBe(1);
  });

  it("counts work orders created this month", () => {
    const s = createSeedState();
    s.orders = [
      { id: "a", number: "1", date: "2026-11-02", vehicleIds: [], purpose: "", senior: "" },
      { id: "b", number: "2", date: "2026-10-30", vehicleIds: [], purpose: "", senior: "" },
    ];
    const stats = computeStats(s, new Date(2026, 10, 24));
    expect(stats.orders).toBe(2);
    expect(stats.ordersThisMonth).toBe(1);
  });
});

describe("operation history", () => {
  it("averages mileage only over vehicles that had trips", () => {
    const s = createSeedState();
    const r = monthTripStats(s.vehicles, s.trips, 2026, 10);
    expect(r.withTrips).toBe(3);
    expect(r.km).toBe(547);
    expect(r.avgKm).toBe(182);
  });

  it("flags 2x and 3x the 100 km daily norm", () => {
    expect(mileageLevel(199)).toBe("normal");
    expect(mileageLevel(200)).toBe("double");
    expect(mileageLevel(300)).toBe("triple");
  });
});

describe("schedules", () => {
  it("includes events that overlap the month", () => {
    const base = { kind: "oup" as const, name: "", place: "", brands: "", teacher: "" };
    const events = [
      { ...base, id: "1", start: "2026-08-30", end: "2026-09-02" },
      { ...base, id: "2", start: "2026-10-01", end: "2026-10-03" },
    ];
    expect(eventsInMonth(events, 2026, 8).map((e) => e.id)).toEqual(["1"]);
  });
});
