/**
 * Password storage.
 *
 * Stored form: scrypt$<N>$<r>$<p>$<salt base64>$<key base64>
 *   - scrypt from node:crypto, 16-byte random salt, 32-byte key.
 *   - Cost parameters travel with each hash, so they can be raised later:
 *     verifyPassword() reports needsRehash for a hash made with other ones.
 *
 * Rows written before hashing was introduced still hold the password itself.
 * verifyPassword() accepts those too (needsRehash = true) so the caller can
 * replace them with a hash on the next successful login; nobody has to reset
 * their password.
 *
 * Every comparison goes through crypto.timingSafeEqual.
 */
import crypto from 'crypto';

/** Current cost: N = 2^15, r = 8, p = 3 (about 32 MiB per hash). */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 3 } as const;
const KEY_LEN = 32;
const SALT_LEN = 16;
const PREFIX = 'scrypt';
const HASH_PATTERN = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;

type Params = { N: number, r: number, p: number };

function derive(password: string, salt: Buffer, params: Params, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLen, { ...params, maxmem: 256 * params.N * params.r + 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

type ParsedHash = { params: Params, salt: Buffer, key: Buffer };

function parse(stored: string): ParsedHash | null {
  const m = HASH_PATTERN.exec(stored);
  if (!m) return null;
  const params = { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  // N must be a power of two above 1; keep the values in a sane range.
  if (!(params.N > 1 && (params.N & (params.N - 1)) === 0 && params.N <= 2 ** 20)) return null;
  if (!(params.r >= 1 && params.r <= 32 && params.p >= 1 && params.p <= 16)) return null;
  const salt = Buffer.from(m[4], 'base64');
  const key = Buffer.from(m[5], 'base64');
  if (salt.length < 8 || key.length < 16) return null;
  return { params, salt, key };
}

/** True when `stored` is a hash this module produced (not a legacy plain value). */
export function isPasswordHash(stored: unknown): boolean {
  return typeof stored === 'string' && parse(stored) !== null;
}

/** Hash a password for storage. */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password must be a non-empty string');
  }
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await derive(password, salt, SCRYPT_PARAMS, KEY_LEN);
  const { N, r, p } = SCRYPT_PARAMS;
  return `${PREFIX}$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Equal-length digests, so timingSafeEqual never throws and length is not revealed. */
function digestEqual(a: string, b: string): boolean {
  const da = crypto.createHash('sha256').update(a, 'utf8').digest();
  const db = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(da, db);
}

export type VerifyResult = { ok: boolean, needsRehash: boolean };

/**
 * Check `password` against a stored value (a hash, or a legacy plain value).
 * needsRehash is true when the check passed and the stored value should be
 * replaced by hashPassword(password).
 */
export async function verifyPassword(password: unknown, stored: unknown): Promise<VerifyResult> {
  if (typeof password !== 'string' || password.length === 0 || typeof stored !== 'string' || stored.length === 0) {
    return { ok: false, needsRehash: false };
  }
  const parsed = parse(stored);
  if (parsed === null) {
    const ok = digestEqual(password, stored);
    return { ok, needsRehash: ok };
  }
  const key = await derive(password, parsed.salt, parsed.params, parsed.key.length);
  const ok = crypto.timingSafeEqual(key, parsed.key);
  const { N, r, p } = SCRYPT_PARAMS;
  const current = parsed.params.N === N && parsed.params.r === r && parsed.params.p === p && parsed.key.length === KEY_LEN;
  return { ok, needsRehash: ok && !current };
}
