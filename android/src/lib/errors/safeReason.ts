/**
 * A one-line, path-free reason safe to store in last_error and show in diagnostics: quoted and bare
 * file paths and URIs are replaced by [path], control characters collapse, max 200 characters.
 */
export function safeReason(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown save error';
  const safe = message
    // Remove quoted paths (including spaces), then unquoted URIs and paths.
    .replace(/["'](?:[a-z][a-z\d+.-]*:\/\/|[a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|[\w.-]+[\\/])[^"']*["']/gi, '[path]')
    .replace(/(?:[a-z][a-z\d+.-]*:\/\/|[a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|\b[\w.-]+[\\/])[^\s"'<>]*/gi, '[path]')
    .replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  return `${prefix}: ${safe || 'Unknown error'}`.slice(0, 200);
}
