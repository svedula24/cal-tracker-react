import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { todayKey } from '@/lib/nutrition';

// The day Home is showing. Shared (not persisted) so the + menu screens log to
// the same day; every app launch starts on today.
let today = todayKey();
let day = today;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

// Past midnight, a selection that was "today" follows the new day, so logging
// never lands on yesterday by accident. A day the user picked stays picked.
function rollOver() {
  const t = todayKey();
  if (t === today) return;
  if (day === today) day = t;
  today = t;
  emit();
}
AppState.addEventListener('change', (s) => s === 'active' && rollOver());
setInterval(rollOver, 60_000);

export function useSelectedDay() {
  const value = useSyncExternalStore(subscribe, () => day, () => day);
  const setDay = (next: string) => {
    day = next;
    emit();
  };
  return [value, setDay] as const;
}
