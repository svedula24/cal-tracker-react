"""The in-process rate limit (app/api/limits.py). No database."""

from app.api.limits import SlidingWindow


def test_allows_up_to_the_limit_then_says_how_long_to_wait():
    now = [0.0]
    window = SlidingWindow(limit=3, per_seconds=60, clock=lambda: now[0])
    assert [window.retry_after("a") for _ in range(3)] == [None, None, None]
    now[0] = 10.0
    assert window.retry_after("a") == 50.0  # the first event leaves the window at t=60
    assert window.retry_after("b") is None  # another key is counted on its own


def test_a_refused_event_is_not_counted_and_old_events_age_out():
    now = [0.0]
    window = SlidingWindow(limit=2, per_seconds=60, clock=lambda: now[0])
    assert window.retry_after("a") is None
    now[0] = 30.0
    assert window.retry_after("a") is None
    for _ in range(5):
        assert window.retry_after("a") is not None  # refused, and refusals do not extend the wait
    now[0] = 60.0  # the event at t=0 has aged out, the one at t=30 has not
    assert window.retry_after("a") is None
    assert window.retry_after("a") == 30.0


def test_keys_whose_events_all_aged_out_are_forgotten():
    now = [0.0]
    window = SlidingWindow(limit=1, per_seconds=60, clock=lambda: now[0])
    for key in ("a", "b", "c"):
        window.retry_after(key)
    now[0] = 61.0
    window.retry_after("d")
    assert set(window._events) == {"d"}


def test_concurrent_calls_never_exceed_the_limit_or_fail():
    import threading

    window = SlidingWindow(limit=50, per_seconds=3600)
    allowed, errors = [], []

    def hammer(n):
        try:
            for i in range(200):
                # Some shared keys (the limit must hold exactly) and many one-off keys (the table changes size).
                allowed.append((window.retry_after("shared") is None, window.retry_after(f"{n}-{i}") is None))
        except Exception as e:  # noqa: BLE001 - any failure here is the bug
            errors.append(e)

    threads = [threading.Thread(target=hammer, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert sum(shared for shared, _ in allowed) == 50
    assert all(own for _, own in allowed)

