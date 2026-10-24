// Paths handled by the Worker. Everything else is the web app's static files.
// Keep in sync with assets.run_worker_first in wrangler.jsonc.

const API_PREFIXES = [
  '/account/',
  '/sync/',
  '/admin/',
  '/openid/',
  '/secret',
  '/gocardless/',
  '/simplefin/',
  '/pluggyai/',
  '/akahu/',
  '/enablebanking/',
  '/cors-proxy/',
];
const API_PATHS = new Set(['/info', '/mode', '/metrics']);

// Client-side routes of the web app that sit under an API prefix. Reloading
// the page on one of them must serve the app, not reach the server.
export const SPA_PATHS = new Set(['/gocardless/link', '/enablebanking/auth_callback']);

export function isApiPath(pathname: string) {
  if (SPA_PATHS.has(pathname)) return false;
  return API_PATHS.has(pathname) || API_PREFIXES.some(p => pathname.startsWith(p));
}
