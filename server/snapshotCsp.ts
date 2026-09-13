/**
 * The lockdown for HTML this server renders but did not author: a captured
 * website, a synced page, a GitHub screen, a canvas release. They all render
 * on the app's own origin, so they all get the same policy — inline styles and
 * remote images/fonts stay (a design needs them), scripts and frames do not.
 *
 * One definition, because the copies had to stay byte-identical and nothing
 * enforced that. It has no imports on purpose: every renderer of untrusted
 * HTML can reach it without pulling in a browser-adjacent module.
 */
export const SNAPSHOT_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: blob: http: https:',
  'font-src data: http: https:',
  'media-src data: blob: http: https:',
].join('; ')
