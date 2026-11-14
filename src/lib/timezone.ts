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

/** What sending the zone needs: storage, the token, the network. Injected, so Node tests run it. */
export type ZoneSenderDeps = {
  zone: () => string | null; // the device's zone now
  recorded: () => Promise<string | null>; // the zone last recorded as the server's
  record: (zone: string) => Promise<void>;
  token: () => Promise<string | null>; // this install's token (null: not registered)
  patch: (token: string, zone: string) => Promise<void>; // PATCH /api/v1/me; rejects on failure
  refused: (error: unknown) => boolean; // the PATCH failed because the server does not know the zone (422)
  registering: () => boolean; // a registration is under way (it sends the zone itself)
};

/**
 * Sends the device's zone when it is not the one recorded as the server's. One send at a time; never
 * rejects (a failure is tried again on the next call). A zone the server refused is not sent again
 * until `forget()` (a new account, or the next start). The zone is recorded only if the token is still
 * the one it was sent with: a registration in between has its own record.
 */
export function createZoneSender(deps: ZoneSenderDeps): { send: () => Promise<void>; forget: () => void } {
  let sending = false;
  let refusedZone: string | null = null;
  const send = async () => {
    if (sending || deps.registering()) return;
    sending = true;
    try {
      const zone = deps.zone();
      if (!zone || zone === refusedZone || (await deps.recorded()) === zone) return;
      const token = await deps.token();
      if (!token) return; // the registration will send it
      try {
        await deps.patch(token, zone);
      } catch (e) {
        if (deps.refused(e)) refusedZone = zone;
        return;
      }
      if (!deps.registering() && (await deps.token()) === token) await deps.record(zone);
    } catch {
      // storage failed: tried again on the next call
    } finally {
      sending = false;
    }
  };
  return { send, forget: () => { refusedZone = null; } };
}
