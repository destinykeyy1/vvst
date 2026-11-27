import { useEffect, useState } from "react";

const KEY = "military-planner-unlocked";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return window.sessionStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

export function unlockSection(_section: string) {
  if (read()) return;
  try {
    window.sessionStorage.setItem(KEY, "true");
  } catch {
    return;
  }
  listeners.forEach((l) => l());
}

export function useSectionUnlocked(_section: string) {
  const [state, setState] = useState<{ ready: boolean; unlocked: boolean }>({ ready: false, unlocked: false });
  useEffect(() => {
    const update = () => setState({ ready: true, unlocked: read() });
    update();
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  return state;
}
