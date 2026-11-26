type PassportField = {
  header: string;
  value: unknown;
  ordinal?: unknown;
};

export function currentEngineHours(vehicle?: { passportData?: readonly PassportField[] | null }) {
  let current: number | null = null;
  for (const field of vehicle?.passportData ?? []) {
    const key = field.header.toLowerCase().replace(/ё/g, "е").replace(/[^а-яa-z0-9]/g, "");
    const isCurrent = key === "103" || key === "n103" ||
      (!/\d|сначала|норм|загод|замесяц|засутки|запериод|остаток/.test(key) && key.includes("моточас") &&
        (key.includes("текущ") || String(field.ordinal) === "103" ||
          key === "показаниясчетчикамоточасов"));
    if (!isCurrent || (typeof field.value !== "number" && typeof field.value !== "string")) continue;
    const token = String(field.value).toLowerCase().replace(/\s+/g, "").replace(/,/g, ".")
      .replace(/(?:моточас(?:ов|а)?|моточ|мч|м\.ч\.?|ч\.?)$/, "");
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/.test(token)) continue;
    const number = Number(token);
    if (Number.isFinite(number) && number >= 0) current = Math.max(current ?? 0, number);
  }
  return current;
}
