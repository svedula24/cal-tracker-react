// The Food Database search controller (src/lib/foodSearch.ts): debounce, abort,
// late responses, timeout, the fallback to the bundled list. Run: npm test
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import { createFoodSearch } from '../src/lib/foodSearch.ts';

beforeEach(() => {
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout'] });
});

const food = (name) => ({ id: `usda:${name}`, name, per100g: {}, portions: [] });
const names = (s) => s.results.map((f) => f.name);
// Lets every settled promise run its handlers (the controller chains a few).
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

/** A remote whose requests are answered by hand: calls[i] = { q, signal, resolve, reject }. */
function fakeRemote() {
  const calls = [];
  const remote = (q, signal) => {
    const d = deferred();
    calls.push({ q, signal, ...d });
    return d.promise;
  };
  return { remote, calls };
}

/** A bundled index: search(q) → one food named "local <q>". `loads` counts local() calls. */
function fakeLocal() {
  const d = deferred();
  const box = { loads: 0, searched: [], ...d };
  box.local = () => (box.loads++, d.promise);
  box.index = { search: (q) => (box.searched.push(q), [food(`local ${q}`)]) };
  return box;
}

function setup({ withRemote = true, ...opts } = {}) {
  const states = [];
  const r = fakeRemote();
  const l = fakeLocal();
  const search = createFoodSearch({ remote: withRemote ? r.remote : undefined, local: l.local, onState: (s) => states.push(s), ...opts });
  return { search, states, calls: r.calls, local: l, last: () => states.at(-1) };
}

test('nothing is emitted or requested at creation with a remote; the bundled list is not loaded', async () => {
  const { states, calls, local } = setup();
  mock.timers.tick(10_000);
  await flush();
  assert.deepEqual([states.length, calls.length, local.loads], [0, 0, 0]);
});

test('debounce: one request, for the last query, 150 ms after the last keystroke', async () => {
  const { search, calls, last, local } = setup();
  search.setQuery('b');
  assert.deepEqual(last(), { query: '', results: [], status: 'loading', source: 'api' });
  mock.timers.tick(149);
  search.setQuery('ba');
  mock.timers.tick(149);
  search.setQuery('ban');
  mock.timers.tick(149);
  await flush();
  assert.equal(calls.length, 0);
  mock.timers.tick(1);
  await flush();
  assert.deepEqual(calls.map((c) => c.q), ['ban']);
  calls[0].resolve([food('Banana, raw')]);
  await flush();
  assert.deepEqual(last(), { query: 'ban', results: [food('Banana, raw')], status: 'ready', source: 'api' });
  assert.equal(local.loads, 0);
});

test('debounceMs is configurable; the query is trimmed and a whitespace-only change is not a new search', async () => {
  const { search, calls, states } = setup({ debounceMs: 50 });
  search.setQuery(' ban ');
  mock.timers.tick(50);
  await flush();
  assert.deepEqual(calls.map((c) => c.q), ['ban']);
  const emitted = states.length;
  search.setQuery('ban  ');
  mock.timers.tick(50);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, false);
  assert.equal(states.length, emitted);
});

test('a new query aborts the request in flight; its late answer and its abort error are ignored', async () => {
  const { search, calls, last, states, local } = setup();
  search.setQuery('ban');
  mock.timers.tick(200);
  await flush();
  search.setQuery('bana');
  assert.equal(calls[0].signal.aborted, true);
  mock.timers.tick(200);
  await flush();
  assert.equal(calls.length, 2);

  // The first request answers late (a server that ignored the abort)…
  calls[0].resolve([food('stale')]);
  await flush();
  assert.equal(last().status, 'loading');
  calls[1].resolve([food('Banana, raw')]);
  await flush();
  assert.deepEqual([last().query, names(last()), last().status], ['bana', ['Banana, raw'], 'ready']);

  // …and an aborted request rejecting is not a failure: no fallback.
  search.setQuery('banan');
  mock.timers.tick(200);
  await flush();
  search.setQuery('banana');
  calls[2].reject(new DOMException('aborted', 'AbortError'));
  await flush();
  assert.equal(local.loads, 0);
  assert.equal(last().source, 'api');
  assert.ok(!states.some((s) => names(s).includes('stale')));
});

test('while a search is in flight the previous results stay up', async () => {
  const { search, calls, last } = setup();
  search.setQuery('ban');
  mock.timers.tick(200);
  await flush();
  calls[0].resolve([food('Banana, raw')]);
  await flush();
  search.setQuery('bana');
  assert.deepEqual(last(), { query: 'ban', results: [food('Banana, raw')], status: 'loading', source: 'api' });
});

test('an empty query is idle: no request, and the pending or in-flight one is dropped', async () => {
  const { search, calls, last } = setup();
  search.setQuery('ban');
  search.setQuery('  ');
  assert.deepEqual(last(), { query: '', results: [], status: 'idle', source: 'api' });
  mock.timers.tick(1000);
  await flush();
  assert.equal(calls.length, 0);

  search.setQuery('ban');
  mock.timers.tick(200);
  await flush();
  search.setQuery('');
  assert.equal(calls[0].signal.aborted, true);
  calls[0].resolve([food('late')]);
  await flush();
  assert.deepEqual(last(), { query: '', results: [], status: 'idle', source: 'api' });
});

test('a failed request falls back to the bundled list, for the query typed by then, and stays on it', async () => {
  const { search, calls, last, local } = setup();
  search.setQuery('ban');
  mock.timers.tick(200);
  await flush();
  calls[0].reject(new Error('ApiUnavailable'));
  await flush();
  assert.equal(local.loads, 1);
  assert.equal(last().status, 'loading'); // the bundle is loading

  // Typed while the bundle loads: no API request, and the load answers this query.
  search.setQuery('banana');
  mock.timers.tick(1000);
  await flush();
  assert.equal(calls.length, 1);
  local.resolve(local.index);
  await flush();
  assert.deepEqual(last(), { query: 'banana', results: [food('local banana')], status: 'ready', source: 'bundled' });
  assert.deepEqual(local.searched, ['banana']);

  // From now on: bundled, synchronous, no debounce, no request, no reload.
  search.setQuery('honey');
  assert.deepEqual(last(), { query: 'honey', results: [food('local honey')], status: 'ready', source: 'bundled' });
  search.setQuery('');
  assert.deepEqual(last(), { query: '', results: [], status: 'idle', source: 'bundled' });
  mock.timers.tick(10_000);
  await flush();
  assert.deepEqual([calls.length, local.loads], [1, 1]);
});

test('a query cleared while the fallback loads ends idle on the bundled list', async () => {
  const { search, calls, last, local } = setup();
  search.setQuery('ban');
  mock.timers.tick(200);
  await flush();
  calls[0].reject(new Error('down'));
  await flush();
  search.setQuery('');
  local.resolve(local.index);
  await flush();
  assert.deepEqual(last(), { query: '', results: [], status: 'idle', source: 'bundled' });
  assert.deepEqual(local.searched, []);
});

test('timeout: a request slower than timeoutMs is aborted and counts as unreachable', async () => {
  const { search, calls, last, local } = setup();
  search.setQuery('ban');
  mock.timers.tick(200);
  await flush();
  mock.timers.tick(3999);
  await flush();
  assert.deepEqual([calls[0].signal.aborted, local.loads], [false, 0]);
  mock.timers.tick(1);
  await flush();
  assert.deepEqual([calls[0].signal.aborted, local.loads], [true, 1]);
  local.resolve(local.index);
  await flush();
  assert.deepEqual([names(last()), last().source], [['local ban'], 'bundled']);

  // The slow answer finally arriving changes nothing.
  calls[0].resolve([food('late')]);
  await flush();
  assert.deepEqual(names(last()), ['local ban']);
});

test('the timeout does not fire after an answer, and timeoutMs is configurable', async () => {
  const { search, calls, last, local } = setup({ timeoutMs: 100 });
  search.setQuery('ban');
  mock.timers.tick(200);
  await flush();
  calls[0].resolve([food('Banana, raw')]);
  await flush();
  mock.timers.tick(10_000);
  await flush();
  assert.deepEqual([last().status, last().source, local.loads], ['ready', 'api', 0]);

  search.setQuery('bana');
  mock.timers.tick(200);
  await flush();
  mock.timers.tick(100);
  await flush();
  assert.equal(local.loads, 1);
});

test('a remote that throws synchronously is a failure too', async () => {
  const states = [];
  const local = fakeLocal();
  const search = createFoodSearch({
    remote: () => {
      throw new Error('no fetch');
    },
    local: local.local,
    onState: (s) => states.push(s),
  });
  search.setQuery('ban');
  mock.timers.tick(200);
  await flush();
  local.resolve(local.index);
  await flush();
  assert.deepEqual([states.at(-1).status, states.at(-1).source], ['ready', 'bundled']);
});

test('both sources failing is "failed"; retry asks the API again, at once', async () => {
  const states = [];
  const r = fakeRemote();
  let loads = 0;
  const search = createFoodSearch({ remote: r.remote, local: () => (loads++, Promise.reject(new Error('no chunk'))), onState: (s) => states.push(s) });
  const last = () => states.at(-1);
  search.setQuery('ban');
  mock.timers.tick(200);
  await flush();
  r.calls[0].reject(new Error('down'));
  await flush();
  assert.deepEqual(last(), { query: 'ban', results: [], status: 'failed', source: 'bundled' });
  assert.equal(loads, 1);

  search.retry();
  assert.equal(last().status, 'loading');
  await flush();
  assert.deepEqual(r.calls.map((c) => c.q), ['ban', 'ban']); // no debounce on retry
  r.calls[1].resolve([food('Banana, raw')]);
  await flush();
  assert.deepEqual(last(), { query: 'ban', results: [food('Banana, raw')], status: 'ready', source: 'api' });

  // Failing again, then a new query: the API is asked again rather than staying failed.
  search.setQuery('bana');
  mock.timers.tick(200);
  await flush();
  r.calls[2].reject(new Error('down'));
  await flush();
  assert.equal(last().status, 'failed');
  search.setQuery('banana');
  mock.timers.tick(200);
  await flush();
  assert.equal(r.calls.at(-1).q, 'banana');
  assert.equal(loads, 2);
});

test('retry after both failed: the API still down, the bundled list now loads', async () => {
  const states = [];
  const r = fakeRemote();
  const good = fakeLocal();
  let loads = 0;
  const search = createFoodSearch({
    remote: r.remote,
    local: () => (loads++ === 0 ? Promise.reject(new Error('no chunk')) : Promise.resolve(good.index)),
    onState: (s) => states.push(s),
  });
  search.setQuery('ban');
  mock.timers.tick(200);
  await flush();
  r.calls[0].reject(new Error('down'));
  await flush();
  assert.equal(states.at(-1).status, 'failed');
  search.retry();
  await flush();
  r.calls[1].reject(new Error('down'));
  await flush();
  assert.deepEqual(states.at(-1), { query: 'ban', results: [food('local ban')], status: 'ready', source: 'bundled' });
});

test('bundled-only: loads at creation without emitting, then idle; each keystroke is searched synchronously', async () => {
  const { search, states, local, last, calls } = setup({ withRemote: false });
  await flush();
  assert.equal(local.loads, 1);
  assert.equal(states.length, 0); // the caller starts in its own loading state
  local.resolve(local.index);
  await flush();
  assert.deepEqual(states, [{ query: '', results: [], status: 'idle', source: 'bundled' }]);

  search.setQuery('b');
  assert.deepEqual(last(), { query: 'b', results: [food('local b')], status: 'ready', source: 'bundled' });
  search.setQuery('ba ');
  assert.deepEqual(last(), { query: 'ba', results: [food('local ba')], status: 'ready', source: 'bundled' });
  search.setQuery('');
  assert.deepEqual(last(), { query: '', results: [], status: 'idle', source: 'bundled' });
  assert.deepEqual([local.loads, calls.length], [1, 0]);
});

test('bundled-only: a query typed while the list loads is answered when it arrives', async () => {
  const { search, states, local, last } = setup({ withRemote: false });
  search.setQuery('ban');
  search.setQuery('bana');
  assert.equal(states.length, 0);
  local.resolve(local.index);
  await flush();
  assert.deepEqual(last(), { query: 'bana', results: [food('local bana')], status: 'ready', source: 'bundled' });
});

test('bundled-only: a failed load is "failed" until retry, which shows loading and loads again', async () => {
  const states = [];
  const good = fakeLocal();
  let loads = 0;
  const pending = deferred();
  const search = createFoodSearch({
    local: () => (loads++ === 0 ? Promise.reject(new Error('no chunk')) : pending.promise),
    onState: (s) => states.push(s),
  });
  await flush();
  assert.deepEqual(states, [{ query: '', results: [], status: 'failed', source: 'bundled' }]);
  search.setQuery('ban'); // typing does not hide the Retry state
  search.setQuery('');
  assert.equal(states.length, 1);

  search.retry();
  search.retry(); // a second tap while loading does not load twice
  assert.equal(states.at(-1).status, 'loading');
  assert.equal(loads, 1); // local() runs on the next microtask
  await flush();
  assert.equal(loads, 2);
  pending.resolve(good.index);
  await flush();
  assert.deepEqual(states.at(-1), { query: '', results: [], status: 'idle', source: 'bundled' });
  search.retry(); // nothing to retry once loaded
  await flush();
  assert.equal(loads, 2);
});

test('dispose: aborts the request, clears the timers, and nothing is emitted afterwards', async () => {
  const a = setup();
  a.search.setQuery('ban'); // debounce pending
  a.search.dispose();
  mock.timers.tick(10_000);
  await flush();
  assert.equal(a.calls.length, 0);

  const b = setup();
  b.search.setQuery('ban');
  mock.timers.tick(200);
  await flush();
  const emitted = b.states.length;
  b.search.dispose();
  assert.equal(b.calls[0].signal.aborted, true);
  b.calls[0].reject(new Error('down'));
  mock.timers.tick(10_000);
  await flush();
  b.search.setQuery('x');
  b.search.retry();
  await flush();
  assert.deepEqual([b.states.length, b.local.loads, b.calls.length], [emitted, 0, 1]);

  // Disposed while the bundled list loads: its arrival is ignored.
  const c = setup({ withRemote: false });
  c.search.dispose();
  c.local.resolve(c.local.index);
  await flush();
  assert.equal(c.states.length, 0);
});

// Types `q`, waits out the debounce and answers the request with one food named "api <q>".
const answer = async (t, q) => {
  t.search.setQuery(q);
  mock.timers.tick(150);
  await flush();
  assert.equal(t.calls.at(-1).q, q);
  t.calls.at(-1).resolve([food(`api ${q}`)]);
  await flush();
};

test('cache: "ban" -> "bana" -> back to "ban" is one request per distinct query; the repeat is answered at once', async () => {
  const t = setup();
  await answer(t, 'ban');
  await answer(t, 'bana');
  const before = t.states.length;
  t.search.setQuery('ban'); // no timer advance, no await
  assert.deepEqual(t.last(), { query: 'ban', results: [food('api ban')], status: 'ready', source: 'api' });
  assert.equal(t.states.length, before + 1); // straight to ready, no 'loading' in between
  mock.timers.tick(10_000);
  await flush();
  assert.deepEqual(t.calls.map((c) => c.q), ['ban', 'bana']);
  assert.equal(t.local.loads, 0);
});

test('cache: a hit cancels the pending debounce and the request in flight for an older query', async () => {
  const t = setup();
  await answer(t, 'ban');
  t.search.setQuery('bana'); // debounce pending
  t.search.setQuery('ban');
  mock.timers.tick(10_000);
  await flush();
  assert.equal(t.calls.length, 1);

  t.search.setQuery('banan');
  mock.timers.tick(150);
  await flush(); // in flight
  t.search.setQuery('ban');
  assert.equal(t.calls[1].signal.aborted, true);
  t.calls[1].resolve([food('late')]);
  mock.timers.tick(10_000); // its timeout is gone too: no fallback
  await flush();
  assert.deepEqual([t.last().query, names(t.last()), t.last().status, t.local.loads], ['ban', ['api ban'], 'ready', 0]);
});

test('cache: the least recently used query is evicted past cacheSize', async () => {
  const t = setup({ cacheSize: 2 });
  await answer(t, 'a');
  await answer(t, 'b');
  t.search.setQuery('a'); // a hit: "a" is now more recent than "b"
  assert.equal(t.last().status, 'ready');
  await answer(t, 'c'); // evicts "b"
  assert.equal(t.calls.length, 3);

  t.search.setQuery('a');
  assert.deepEqual([t.last().status, names(t.last())], ['ready', ['api a']]);
  t.search.setQuery('c');
  assert.deepEqual([t.last().status, names(t.last())], ['ready', ['api c']]);
  t.search.setQuery('b');
  assert.equal(t.last().status, 'loading');
  mock.timers.tick(150);
  await flush();
  assert.deepEqual(t.calls.map((c) => c.q), ['a', 'b', 'c', 'b']);
});

test('cache: a failed request is not cached, bundled results are not cached, and the cache is not used after the fallback', async () => {
  const states = [];
  const r = fakeRemote();
  let loads = 0;
  const good = fakeLocal();
  const search = createFoodSearch({
    remote: r.remote,
    local: () => (loads++ === 0 ? Promise.reject(new Error('no chunk')) : Promise.resolve(good.index)),
    onState: (s) => states.push(s),
  });
  const t = { search, calls: r.calls };
  await answer(t, 'ok'); // cached from the API
  search.setQuery('ban');
  mock.timers.tick(150);
  await flush();
  r.calls[1].reject(new Error('down'));
  await flush();
  assert.equal(states.at(-1).status, 'failed'); // both failed: the API is asked again next time

  search.setQuery('bana');
  search.setQuery('ban'); // the failure was not cached: debounce, then a request
  assert.equal(states.at(-1).status, 'loading');
  mock.timers.tick(150);
  await flush();
  assert.deepEqual(r.calls.map((c) => c.q), ['ok', 'ban', 'ban']);
  r.calls[2].reject(new Error('down'));
  await flush();
  assert.deepEqual(states.at(-1), { query: 'ban', results: [food('local ban')], status: 'ready', source: 'bundled' });

  // On the bundled list now: "ok" comes from it, not from the cached API answer.
  search.setQuery('ok');
  assert.deepEqual(states.at(-1), { query: 'ok', results: [food('local ok')], status: 'ready', source: 'bundled' });
  assert.equal(r.calls.length, 3);
});

test('cache: cacheSize 0 disables it', async () => {
  const t = setup({ cacheSize: 0 });
  await answer(t, 'ban');
  await answer(t, 'bana');
  t.search.setQuery('ban');
  assert.equal(t.last().status, 'loading');
});
