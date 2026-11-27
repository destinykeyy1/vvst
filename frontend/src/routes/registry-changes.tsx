import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Button, PageHeader, Panel } from "@/components/ui-kit";

import { PasswordGate } from "@/components/PasswordGate";

export const Route = createFileRoute("/registry-changes")({
  component: HistoryPage,
});

type Change = {
  id: string;
  changedAt: string;
  vehicleId: string;
  regNumber: string;
  column: string;
  old: string | number | boolean | null;
  new: string | number | boolean | null;
};

function HistoryPage() {
  const [session, setSession] = useState(0);
  const expire = useCallback(() => setSession(value => value + 1), []);
  return (
    <PasswordGate key={session} section="registry-changes" title="История изменений ВВСТ">
      <RegistryChanges onExpired={expire} />
    </PasswordGate>
  );
}

function RegistryChanges({ onExpired }: { onExpired: () => void }) {
  const [rows, setRows] = useState<Change[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setBusy(true);
      setError("");
      try {
        const suffix = cursor ? `?before=${encodeURIComponent(cursor)}` : "";
        const response = await fetch(`/api/registry-changes${suffix}`, {
          signal: controller.signal, cache: "no-store",
        });
        if (response.status === 401) {
          if (!controller.signal.aborted) onExpired();
          return;
        }
        if (!response.ok) throw new Error("Не удалось загрузить историю изменений.");
        const page: { items: Change[]; next: string | null } = await response.json();
        if (controller.signal.aborted) return;
        setRows(page.items);
        setNext(page.next);
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : "Ошибка загрузки.");
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [cursor, revision, onExpired]);

  function reload() {
    setCursor(null);
    setRevision(value => value + 1);
  }

  return (
    <div>
      <PageHeader title="История изменений ВВСТ" />
      {error && <p role="alert" className="mb-3 text-sm text-red-700">{error}</p>}
      <Panel>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted text-xs text-muted-foreground">
              <tr>{["Дата", "Время", "Рег. номер", "Колонка", "Было", "Стало"].map(
                label => <th key={label} className="px-4 py-3">{label}</th>
              )}</tr>
            </thead>
            <tbody>{rows.map(row => {
              const time = new Date(row.changedAt);
              const cells = [time.toLocaleDateString("ru-RU"), time.toLocaleTimeString("ru-RU"),
                row.regNumber || `№ ${row.vehicleId}`, row.column, row.old, row.new];
              return <tr key={row.id} className="border-t">{cells.map((cell, index) =>
                <td key={index} className="whitespace-pre-wrap break-words px-4 py-2">
                  {cell == null || cell === "" ? "—" : String(cell)}
                </td>
              )}</tr>;
            })}</tbody>
          </table>
        </div>
        {busy && <p role="status" className="p-4 text-sm">Загрузка…</p>}
        {!busy && !error && !rows.length && <p className="p-4 text-sm">Изменений пока нет.</p>}
        <div className="flex gap-2 border-t p-3">
          <Button variant="outline" disabled={busy} onClick={reload}>
            {cursor ? "К последним изменениям" : "Обновить"}
          </Button>
          {next && <Button variant="outline" disabled={busy} onClick={() => setCursor(next)}>
            Предыдущие записи
          </Button>}
        </div>
      </Panel>
    </div>
  );
}
