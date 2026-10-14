import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { createDemoState, deriveState, localDay } from '../src/demo.ts';
import type { AppState, AppUser } from '../src/types.ts';
import { HttpError } from './errors.ts';
import { normalizeEmail, validatePassword } from './validation.ts';
import { closeUnavailableTracking, type PointReceipts } from './tracking.ts';

export interface RepositoryOptions {
  databasePath?: string;
  adminEmail?: string;
  adminPassword?: string;
  adminName?: string;
  demoSeed?: boolean;
  demoDriverPassword?: string;
  sessionTtlMs?: number;
  now?: () => number;
}
export interface Snapshot { state: AppState; revision: number }
export interface Session { user: AppUser; expiresAt: string }
interface Credentials { salt: string; password_hash: string }
interface SessionRow { user_id: string; expires_at: number }

function hashPassword(password: string, salt = randomBytes(24).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}
function tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }

export class Repository {
  private db: DatabaseSync;
  private now: () => number;
  private sessionTtlMs: number;
  private dummy = hashPassword(randomBytes(32).toString('hex'));
  readonly demoSeed: boolean;

  constructor(options: RepositoryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    this.demoSeed = options.demoSeed ?? process.env.API_DEMO_SEED === '1';
    const path = options.databasePath ?? process.env.DATABASE_PATH ?? '.local/data/rota.sqlite';
    if (path !== ':memory:') {
      const directory = dirname(resolve(path));
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (user_id TEXT PRIMARY KEY, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES credentials(user_id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS tracking_owners (session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tracking_receipts (session_id TEXT NOT NULL, point_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
        PRIMARY KEY(session_id, point_id));`);
    try {
      if (!this.db.prepare('SELECT id FROM app_state WHERE id = 1').get()) this.initialize(options);
      const mode = this.db.prepare("SELECT value FROM metadata WHERE key = 'simulation'").get() as { value: string } | undefined;
      // Existing operational databases never become simulated because of a changed environment flag.
      this.demoSeed = mode?.value === '1';
    } catch (error) { this.db.close(); throw error; }
  }

  private initialize(options: RepositoryOptions) {
    const email = normalizeEmail(options.adminEmail ?? process.env.ROTA_ADMIN_EMAIL);
    const password = validatePassword(options.adminPassword ?? process.env.ROTA_ADMIN_PASSWORD);
    const name = (options.adminName ?? process.env.ROTA_ADMIN_NAME ?? 'Administrador').trim();
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, 'ROTA_ADMIN_NAME inválido.');
    const admin: AppUser = { id: randomUUID(), name, email, role: 'admin', active: true };
    const state: AppState = this.demoSeed ? createDemoState(localDay(new Date(this.now())))
      : { version: 1, demoDate: localDay(new Date(this.now())), drivers: [], deliveries: [], trips: [], users: [], trackingSessions: [], gpsDays: [] };
    if (this.demoSeed) state.users = state.users.filter(user => user.role !== 'admin');
    if (state.users.some(user => user.email === email)) throw new HttpError(400, 'O e-mail do administrador coincide com um usuário de demonstração.');
    state.users.unshift(admin);
    this.transaction(() => {
      this.db.prepare('INSERT INTO app_state (id, data, revision) VALUES (1, ?, 0)').run(JSON.stringify(state));
      this.db.prepare("INSERT INTO metadata(key, value) VALUES ('simulation', ?)").run(this.demoSeed ? '1' : '0');
      this.setPassword(admin.id, password);
      const demoDriverPassword = options.demoDriverPassword ?? process.env.ROTA_DEMO_DRIVER_PASSWORD;
      if (this.demoSeed && demoDriverPassword) {
        const driver = state.users.find(user => user.driverId === 'd1');
        if (driver) this.setPassword(driver.id, validatePassword(demoDriverPassword));
      }
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  read(): Snapshot {
    const row = this.db.prepare('SELECT data, revision FROM app_state WHERE id = 1').get() as { data: string; revision: number };
    const state = JSON.parse(row.data) as AppState;
    return { state: deriveState({ ...state, demoDate: localDay(new Date(this.now())), trackingSessions: state.trackingSessions ?? [], gpsDays: state.gpsDays ?? [] }), revision: row.revision };
  }

  mutate(operation: (snapshot: Snapshot) => { state: AppState; message: string }, expectedRevision?: number): Snapshot & { message: string } {
    return this.transaction(() => {
      const snapshot = this.read();
      if (expectedRevision !== undefined && snapshot.revision !== expectedRevision) throw new HttpError(409, 'Os dados foram atualizados. Recarregue antes de tentar novamente.');
      const output = operation(snapshot);
      if (output.state === snapshot.state) throw new HttpError(422, output.message);
      const result = { ...output, state: closeUnavailableTracking(output.state, this.now()) };
      const revision = snapshot.revision + 1;
      this.db.prepare('UPDATE app_state SET data = ?, revision = ? WHERE id = 1').run(JSON.stringify(result.state), revision);
      this.revokeChangedUsers(snapshot.state, result.state);
      return { ...result, revision };
    });
  }

  /** GPS state and point receipts commit together, including duplicate-only retries. */
  mutateTracking<T extends { state: AppState }>(operation: (snapshot: Snapshot, receipts: PointReceipts) => T): T & { revision: number } {
    return this.transaction(() => {
      const snapshot = this.read();
      const receipts: PointReceipts = {
        hash: (sessionId, pointId) => (this.db.prepare('SELECT payload_hash FROM tracking_receipts WHERE session_id = ? AND point_id = ?')
          .get(sessionId, pointId) as { payload_hash: string } | undefined)?.payload_hash,
        remember: (sessionId, pointId, hash) => { this.db.prepare('INSERT INTO tracking_receipts(session_id, point_id, payload_hash) VALUES (?, ?, ?)').run(sessionId, pointId, hash); },
        owner: (sessionId) => this.trackingOwner(sessionId),
        bind: (sessionId, userId) => { this.db.prepare('INSERT INTO tracking_owners(session_id, user_id) VALUES (?, ?)').run(sessionId, userId); },
      };
      const result = operation(snapshot, receipts);
      let revision = snapshot.revision;
      if (result.state !== snapshot.state) {
        revision++;
        this.db.prepare('UPDATE app_state SET data = ?, revision = ? WHERE id = 1').run(JSON.stringify(result.state), revision);
      }
      return { ...result, revision };
    });
  }

  trackingOwner(sessionId: string): string | undefined {
    return (this.db.prepare('SELECT user_id FROM tracking_owners WHERE session_id = ?').get(sessionId) as { user_id: string } | undefined)?.user_id;
  }

  private revokeChangedUsers(before: AppState, after: AppState) {
    for (const previous of before.users) {
      const next = after.users.find(user => user.id === previous.id);
      if (!next) this.db.prepare('DELETE FROM credentials WHERE user_id = ?').run(previous.id);
      if (!next || next.role !== previous.role || next.active !== previous.active || next.driverId !== previous.driverId || next.email !== previous.email) {
        this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(previous.id);
      }
    }
  }

  hasCredentials(userId: string) { return !!this.db.prepare('SELECT user_id FROM credentials WHERE user_id = ?').get(userId); }

  setPassword(userId: string, password: string) {
    const { salt, hash } = hashPassword(validatePassword(password));
    this.db.prepare('INSERT INTO credentials(user_id, salt, password_hash) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET salt = excluded.salt, password_hash = excluded.password_hash').run(userId, salt, hash);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  login(email: string, password: string): Session & { token: string } {
    const user = this.read().state.users.find(item => item.email === email && item.active);
    const credentials = user ? this.db.prepare('SELECT salt, password_hash FROM credentials WHERE user_id = ?').get(user.id) as Credentials | undefined : undefined;
    const salt = credentials?.salt ?? this.dummy.salt;
    const expected = Buffer.from(credentials?.password_hash ?? this.dummy.hash, 'hex');
    const actual = scryptSync(password, salt, 64);
    if (!timingSafeEqual(expected, actual) || !user || !credentials) throw new HttpError(401, 'E-mail ou senha incorretos.');
    const token = randomBytes(32).toString('base64url');
    const expires = this.now() + this.sessionTtlMs;
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.now());
    this.db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash(token), user.id, expires);
    return { token, user, expiresAt: new Date(expires).toISOString() };
  }

  session(token: string): Session {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(401, 'Entre na sua conta para continuar.');
    const row = this.db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(tokenHash(token)) as SessionRow | undefined;
    const user = row ? this.read().state.users.find(item => item.id === row.user_id && item.active) : undefined;
    if (!row || row.expires_at <= this.now() || !user) {
      this.logout(token);
      throw new HttpError(401, 'Sua sessão expirou. Entre novamente.');
    }
    return { user, expiresAt: new Date(row.expires_at).toISOString() };
  }

  logout(token: string) { this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token)); }
  close() { this.db.close(); }
}

export function openRepository(options: RepositoryOptions = {}) { return new Repository(options); }
