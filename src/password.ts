// Password hashing with PBKDF2-SHA256 from the Web Crypto API.
//
// The regular Actual server uses argon2, which is a native Node module and
// cannot run on Cloudflare Workers. 100,000 iterations is the most the
// Workers runtime allows for PBKDF2.

const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;
const PREFIX = 'pbkdf2_sha256';

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function isValidPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length > 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return `${PREFIX}$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(
  password: unknown,
  stored: unknown,
): Promise<boolean> {
  if (!isValidPassword(password) || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== PREFIX) return false;

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > ITERATIONS) {
    return false;
  }

  try {
    const expected = fromBase64(parts[3]);
    const actual = await derive(password, fromBase64(parts[2]), iterations);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}
