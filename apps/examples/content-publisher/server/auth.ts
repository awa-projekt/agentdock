/**
 * The smallest auth that still demonstrates the real pattern: a hardcoded set
 * of demo users, an opaque session id stored server-side, and a signed
 * http-only cookie. Swap the user list + session store for your real ones; the
 * shape the rest of the app relies on (`getUser(c)`) stays the same.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { config } from './config';

export type User = {
  readonly id: string;
  readonly email: string;
  readonly name: string;
};

type DemoUser = User & { readonly password: string };

const DEMO_USERS: ReadonlyArray<DemoUser> = [
  { id: 'u_editor', email: 'editor@example.com', name: 'Sam Editor', password: 'demo123' },
  { id: 'u_writer', email: 'writer@example.com', name: 'Jules Writer', password: 'demo123' },
];

const COOKIE = 'cp_session';
const sessions = new Map<string, User>();

export const verifyCredentials = (email: string, password: string): User | undefined => {
  const match = DEMO_USERS.find((u) => u.email === email && u.password === password);
  if (!match) return undefined;
  const { password: _pw, ...user } = match;
  return user;
};

export const startSession = async (c: Context, user: User): Promise<void> => {
  const sid = crypto.randomUUID();
  sessions.set(sid, user);
  await setSignedCookie(c, COOKIE, sid, config.sessionSecret, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
};

export const endSession = async (c: Context): Promise<void> => {
  const sid = await getSignedCookie(c, config.sessionSecret, COOKIE);
  if (sid) sessions.delete(sid);
  deleteCookie(c, COOKIE, { path: '/' });
};

const readUser = async (c: Context): Promise<User | undefined> => {
  const sid = await getSignedCookie(c, config.sessionSecret, COOKIE);
  return sid ? sessions.get(sid) : undefined;
};

/** Hono variable: the authenticated user, set by `requireAuth`. */
type AuthVars = { user: User };

export const requireAuth: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
  const user = await readUser(c);
  if (!user) return c.json({ error: 'Not authenticated' }, 401);
  c.set('user', user);
  await next();
};

export const currentUser = (c: Context): User | undefined => readUserSync(c);

// SAFETY: `requireAuth` runs before every protected route and is the only
// writer of this context var, so it holds the `User` it set.
const readUserSync = (c: Context): User | undefined => c.get('user') as User | undefined;

export { readUser };
