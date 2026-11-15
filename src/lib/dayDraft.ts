// What the steps and workout-calories cards on Home save. Pure (no React Native), unit-tested in
// tests/dayDraft.test.mjs.
//
// A card saves on Enter and again when the field loses focus. Both handlers can run before React
// renders the last keystroke, so they must not read the draft from a render: they take the latest
// text from a DraftBox, filled synchronously on every change. `take` empties the box, so whichever
// handler runs second (blur after Enter) finds nothing and saves nothing.

/** A typed whole number (commas allowed); null when it is not one. */
export const parseWhole = (t: string): number | null => {
  const s = t.replace(/,/g, '').trim();
  return /^\d{1,7}$/.test(s) ? Number(s) : null;
};

/** The latest text typed for a day, handed out once. Text typed for another day is never handed out. */
export type DraftBox = {
  set: (day: string, text: string) => void;
  take: (day: string) => string | null;
};

export function createDraftBox(): DraftBox {
  let held: { day: string; text: string } | null = null;
  return {
    set: (day, text) => {
      held = { day, text };
    },
    take: (day) => {
      const text = held !== null && held.day === day ? held.text : null;
      held = null;
      return text;
    },
  };
}

/** The steps to save from the taken text: null when nothing was typed, it isn't a number, or it is unchanged. */
export function stepsToSave(text: string | null, steps: number): number | null {
  const n = text === null ? null : parseWhole(text);
  return n !== null && n !== steps ? n : null;
}

/**
 * The workout calories to save from the taken text: `{ kcal }` to save (null = the day uses the goal's
 * amount), or null to save nothing (nothing typed, or not a number). An unchanged value is saved
 * anyway: the card's own value can lag the store a moment, and writing the same value is harmless.
 */
export function workoutToSave(text: string | null): { kcal: number | null } | null {
  if (text === null) return null;
  if (text.trim() === '') return { kcal: null };
  const n = parseWhole(text);
  return n === null ? null : { kcal: n };
}
