/**
 * A process-wide unique id for client-minted identities (tab ids, instance
 * keys, custom-editor rows).
 *
 * `crypto.randomUUID` exists ONLY in a secure context (https, or a page on
 * `localhost`). This plugin is routinely served over plain HTTP on a LAN
 * address — `--host 10.x.x.x --port 3081`, the deployment mode its own README
 * documents — where `crypto.randomUUID` is simply `undefined`. Calling it
 * unguarded throws `TypeError: crypto.randomUUID is not a function` from
 * inside a `reducer`, which aborts the whole dispatch: the `+` / new-tab
 * button then does nothing at all, with the error only visible in the console.
 *
 * The fallback is the same shape the custom-editor ids already used: a
 * time-ordered prefix plus randomness, unique per tab click in practice and
 * never sent to a host as a security token.
 *
 * @returns a fresh id; a UUID where the platform offers one.
 */
export function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`
}
