// The sync wire format, shared with the server (backend/app/schemas/logs.py). No imports from
// the app, so the engine, the API client and the mapping can all import this file.
// Timestamps are ISO 8601 with a zone; dates are YYYY-MM-DD.

export type Table = 'food_logs' | 'saved_foods' | 'goals' | 'daily_steps';

export type NutrientValues = {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  /** null = the database does not report it (the app shows 0). */
  fiber_g: number | null;
  sugar_g: number | null;
  sodium_mg: number | null;
};

export type FoodLogRow = {
  /** UUID, made by the client. */
  id: string;
  /** null = a custom entry. */
  fdc_id: number | null;
  /** The local day eaten. */
  log_date: string;
  logged_at: string;
  /** User-editable. */
  name: string;
  /** The database name; null for a custom entry. */
  food_name: string | null;
  unit: 'g' | 'serving';
  /** Grams, or servings. */
  quantity: number;
  /** The entry's own values: per 100 g (unit g) or per serving. */
  values: NutrientValues;
  /** The database food's per 100 g when logged; null for a custom entry. */
  food_values: NutrientValues | null;
  /** The client's edit time. */
  updated_at: string;
  deleted_at: string | null;
};

export type SavedFoodRow = {
  fdc_id: number;
  saved_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type GoalRow = {
  effective_date: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  sugar_g: number;
  sodium_mg: number;
  steps: number;
  goal: 'lose' | 'maintain' | 'gain';
  updated_at: string;
  deleted_at: string | null;
};

export type DailyStepsRow = {
  log_date: string;
  steps: number;
  updated_at: string;
  deleted_at: string | null;
};

export type SyncChanges = {
  food_logs: FoodLogRow[];
  saved_foods: SavedFoodRow[];
  goals: GoalRow[];
  daily_steps: DailyStepsRow[];
};

export type SyncRequest = { cursor: number | null; changes: Partial<SyncChanges> };

export type SyncResponse = {
  cursor: number;
  has_more: boolean;
  changes: SyncChanges;
  rejected: { table: keyof SyncChanges; key: string; reason: string }[];
};

/** The server refused the token (401): register again and resend everything. */
export class SyncUnauthorized extends Error {
  constructor(message = 'The server did not accept this device') {
    super(message);
    this.name = 'SyncUnauthorized';
  }
}
