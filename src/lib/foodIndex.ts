// Offline search over the bundled foods. Pure (no React / React Native), so
// Node can unit-test it: tests/foodIndex.test.mjs. A plain scan of all ~13k
// foods takes under 1 ms per query (measured), so there is no extra index.
import type { Food } from '@/data/foods';

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

type Entry = { food: Food; words: string[]; head: string[] }; // head = words before the first comma

export function createFoodIndex(foods: Food[]) {
  const entries: Entry[] = foods.map((food) => ({ food, words: words(food.name), head: words(food.name.split(',')[0]) }));

  /**
   * Foods whose name has a word starting with every query word ("ban" finds
   * "Banana"; "greek yog" finds "Yogurt, Greek"). Best first: all query words in
   * the main name (before the first comma), then the first query word earliest,
   * then shorter names. So "banana" → "Banana, raw" before "Pudding, banana".
   */
  return function search(query: string, limit = 50): Food[] {
    const q = words(query);
    if (!q.length) return [];
    const hits: { food: Food; head: number; pos: number; len: number }[] = [];
    for (const e of entries) {
      if (!q.every((t) => e.words.some((w) => w.startsWith(t)))) continue;
      hits.push({
        food: e.food,
        head: q.every((t) => e.head.some((w) => w.startsWith(t))) ? 0 : 1,
        pos: e.words.findIndex((w) => w.startsWith(q[0])),
        len: e.food.name.length,
      });
    }
    hits.sort((a, b) => a.head - b.head || a.pos - b.pos || a.len - b.len);
    return hits.slice(0, limit).map((h) => h.food);
  };
}
