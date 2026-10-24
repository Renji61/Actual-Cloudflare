// Response helpers that mirror what the regular Express-based server sends,
// so the unmodified Actual web app sees the same status codes and bodies.

export function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/** Express's res.send(string) responds with text/html. */
export function text(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export function empty(status: number) {
  return new Response(null, { status });
}

export function notFound(method: string, path: string) {
  return text(`Cannot ${method} ${path}`, 404);
}

const ALLOWED_METHODS = 'GET,HEAD,PUT,PATCH,POST,DELETE';

/** Same behaviour as the `cors` middleware with its default options. */
export function preflight(request: Request) {
  const headers = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Content-Length': '0',
  });
  const requested = request.headers.get('Access-Control-Request-Headers');
  if (requested) {
    headers.set('Access-Control-Allow-Headers', requested);
    headers.set('Vary', 'Access-Control-Request-Headers');
  }
  return new Response(null, { status: 204, headers });
}

export function withCors(response: Response) {
  const copy = new Response(response.body, response);
  copy.headers.set('Access-Control-Allow-Origin', '*');
  return copy;
}
