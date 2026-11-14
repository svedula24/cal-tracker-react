// The device's IANA timezone ("America/Los_Angeles"), which the server needs for the user's "today"
// (backend: users.timezone). From Intl, which Hermes ships: no package. Pure, so Node tests import it.

/**
 * What to record as the zone the server has, after registering with `sent`: the zone when the server
 * stored it (`stored`, from the 201), else null (clear the record: send it again later). A server that
 * does not know a zone stores UTC; an older one does not report it.
 */
export function zoneToRecord(sent: string | null, stored: string | null): string | null {
  return sent !== null && stored === sent ? sent : null;
}

/**
 * The device's timezone name, or null when the runtime does not say (no Intl, or an empty answer).
 * `resolve` is for tests.
 */
export function currentTimezone(resolve: () => string | undefined = () => Intl.DateTimeFormat().resolvedOptions().timeZone): string | null {
  try {
    const zone = resolve();
    // An IANA name is short and has no spaces; anything else is not worth sending.
    return typeof zone === 'string' && /^[A-Za-z0-9_+\-/]{1,64}$/.test(zone) ? zone : null;
  } catch {
    return null;
  }
}
