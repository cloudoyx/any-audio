/**
 * Same-origin API helper for the plugin's own host routes.
 *
 * Every route requires the `x-any-audio-client` header (the page proves it is the
 * plugin's own client, not a cross-site request); media routes are the exception
 * and are fetched directly by `<audio>` / `<video>`.
 */
const API = '/api/dsh-any-audio'

export { API }

export async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'x-any-audio-client': 'any-audio/1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = {}
  try {
    data = await response.json()
  } catch {
    data = {}
  }
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}
