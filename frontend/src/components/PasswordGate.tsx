import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  apiAccessLogin,
  apiAccessSetup,
  apiAccessStatus,
  AuthError,
  type AccessScope,
  type AccessStatus,
} from "@/lib/api";
import { unlockSection, useSectionUnlocked } from "@/lib/unlock";
import { Button, Input, Panel } from "./ui-kit";

const SECTION_SCOPES: Record<string, AccessScope> = {
  statistics: "general",
  vvst: "general",
  "registry-changes": "general",
  card: "general",
  oup: "general",
  household: "general",
  events: "general",
  history: "general",
  unavailable: "general",
  "writeoff/akb": "general",
  "writeoff/tires": "general",
  "writeoff/headsets": "general",
  "writeoff/tarps": "general",
  order: "general",
};

export function PasswordGate({
  section,
  title,
  children,
}: {
  section: string;
  title: string;
  children: ReactNode;
}) {
  const scope = SECTION_SCOPES[section] ?? "passport";
  const { ready } = useSectionUnlocked(section);
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [apiAuthenticated, setApiAuthenticated] = useState<boolean | null>(
    null,
  );
  const busyRef = useRef(false);
  const requestController = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    apiAccessStatus(scope, controller.signal)
      .then((s) => {
        if (cancelled || controller.signal.aborted) return;
        setStatus(s);
        setApiAuthenticated(s.authenticated);
        if (s.authenticated) unlockSection(section);
      })
      .catch((err) => {
        if (cancelled || controller.signal.aborted) return;
        if (err instanceof AuthError) {
          setApiAuthenticated(false);
        } else {
          setStatusFailed(true);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [scope, section]);

  useEffect(() => {
    return () => {
      requestController.current?.abort();
      requestController.current = null;
    };
  }, []);

  const authenticated =
    status?.authenticated === true || apiAuthenticated === true;
  const showContent = authenticated;

  if (!ready) return null;
  if (!showContent && status === null && !statusFailed) return null;
  if (showContent) return <>{children}</>;

  const needsSetup = status !== null && !status.configured;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    requestController.current = controller;
    try {
      const result = needsSetup
        ? await apiAccessSetup(scope, value, controller.signal)
        : await apiAccessLogin(scope, value, controller.signal);
      if (result.authenticated) {
        setApiAuthenticated(true);
        unlockSection(section);
      } else {
        setError("Не удалось подтвердить доступ. Попробуйте ещё раз.");
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(
          err instanceof Error ? err.message : "Ошибка соединения с сервером.",
        );
      }
    } finally {
      if (requestController.current === controller) {
        requestController.current = null;
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <div className="-m-8 flex min-h-screen items-center justify-center bg-muted p-8">
      <Panel className="w-full max-w-sm px-6 py-7 shadow-sm">
        <form onSubmit={submit}>
          <h1 className="text-lg font-semibold">{title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {needsSetup
              ? "Пароль ещё не задан. Придумайте пароль для доступа к разделу (минимум 8 символов)."
              : "Введите пароль для доступа к разделу."}
          </p>
          <label className="mt-6 block text-sm" htmlFor={`pw-${section}`}>
            Пароль
          </label>
          <Input
            id={`pw-${section}`}
            type="password"
            autoFocus
            minLength={needsSetup ? 8 : undefined}
            className="mt-2"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError("");
            }}
          />
          {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
          {statusFailed && (
            <p className="mt-4 text-sm text-destructive">
              Сервер недоступен. Запустите Military Planner.
            </p>
          )}
          <Button type="submit" className="mt-6 w-full" disabled={busy}>
            {busy ? "Проверка..." : needsSetup ? "Задать пароль" : "Войти"}
          </Button>
        </form>
      </Panel>
    </div>
  );
}
