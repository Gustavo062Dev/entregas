import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApiServer } from './app.ts';
import type { AppState, AppUser } from '../src/types.ts';
import type { Command } from '../src/domain.ts';

// These credentials belong only to the isolated, disposable test databases.
const ADMIN_EMAIL = 'admin@example.test';
const ADMIN_PASSWORD = 'Senha-de-teste-admin-2026';
const DRIVER_EMAIL = 'entregador1@example.com';
const DRIVER_PASSWORD = 'Senha-de-teste-driver-2026';
const USER_PASSWORD = 'Senha-de-teste-user-2026';
const NOW = Date.parse('2026-10-13T14:00:00Z');

interface StateResponse { state: AppState; revision: number; simulation: boolean; message?: string }
interface LoginResponse { token: string; user: AppUser; expiresAt: string }
interface ErrorResponse { error: string }
interface ApiResponse<T> { status: number; headers: Headers; body: T | null }
type Options = NonNullable<Parameters<typeof createApiServer>[0]>;
interface Fixture {
  server: Server;
  origin: string;
  request: <T = ErrorResponse>(path: string, options?: { token?: string; body?: unknown; raw?: string; method?: string }) => Promise<ApiResponse<T>>;
  login: (email?: string, password?: string) => Promise<LoginResponse>;
  state: (token: string) => Promise<StateResponse>;
  command: (token: string, command: Command, revision?: number) => Promise<ApiResponse<StateResponse>>;
  saveUser: (token: string, user: AppUser, password?: string) => Promise<ApiResponse<StateResponse>>;
  close: () => Promise<void>;
}
const fixtures: Fixture[] = [];
const directories: string[] = [];

async function createFixture(options: Options = {}): Promise<Fixture> {
  const server = createApiServer({ databasePath: ':memory:', adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASSWORD,
    adminName: 'Administrador de teste', demoSeed: true, demoDriverPassword: DRIVER_PASSWORD, now: () => NOW, ...options });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request: Fixture['request'] = async <T>(path: string, options: { token?: string; body?: unknown; raw?: string; method?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined || options.raw !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${origin}${path}`, {
      method: options.method ?? (options.body !== undefined || options.raw !== undefined ? 'POST' : 'GET'), headers,
      body: options.raw ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as T : null };
  };
  const fixture: Fixture = {
    server, origin, request,
    async login(email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
      const response = await request<LoginResponse>('/api/auth/login', { body: { email, password } });
      expect(response.status).toBe(200);
      expect(response.body).not.toBeNull();
      return response.body!;
    },
    async state(token) {
      const response = await request<StateResponse>('/api/state', { token });
      expect(response.status).toBe(200);
      return response.body!;
    },
    async command(token, command, revision) {
      const current = revision ?? (await fixture.state(token)).revision;
      return request<StateResponse>('/api/commands', { token, body: { command, revision: current } });
    },
    async saveUser(token, user, password) {
      return request<StateResponse>('/api/users', { token, body: { user, ...(password === undefined ? {} : { password }) } });
    },
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
  fixtures.push(fixture);
  return fixture;
}

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'rota-api-test-'));
  directories.push(directory);
  return join(directory, 'rota.sqlite');
}

function expectNoCredentials(value: unknown) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(expectNoCredentials); return; }
  for (const [key, child] of Object.entries(value)) {
    expect(['password', 'password_hash', 'passwordHash', 'salt', 'token', 'token_hash', 'tokenHash']).not.toContain(key);
    expectNoCredentials(child);
  }
}

async function createUser(fixture: Fixture, adminToken: string, role: AppUser['role'] = 'driver', id = 'new-test-user') {
  const user: AppUser = { id, name: 'Usuário de teste', email: `${id}@example.test`, role, active: true };
  const response = await fixture.saveUser(adminToken, user, USER_PASSWORD);
  expect(response.status).toBe(200);
  return response.body!.state.users.find(item => item.id === id)!;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('API: autenticação e sessões', () => {
  it('provisiona o primeiro administrador e inicia produção sem entregas fictícias', async () => {
    const fixture = await createFixture({ demoSeed: false });
    const login = await fixture.login(' ADMIN@EXAMPLE.TEST ', ADMIN_PASSWORD);
    expect(login.user).toMatchObject({ name: 'Administrador de teste', email: ADMIN_EMAIL, role: 'admin', active: true });
    expect(login.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const snapshot = await fixture.state(login.token);
    expect(snapshot).toMatchObject({ revision: 0, simulation: false });
    expect(snapshot.state.users).toEqual([login.user]);
    expect(snapshot.state.drivers).toEqual([]);
    expect(snapshot.state.deliveries).toEqual([]);
    expect(snapshot.state.trips).toEqual([]);
  });

  it('recusa senha errada e conta desconhecida com a mesma resposta', async () => {
    const fixture = await createFixture();
    const wrongPassword = await fixture.request('/api/auth/login', { body: { email: ADMIN_EMAIL, password: 'senha-incorreta-de-teste' } });
    const unknownUser = await fixture.request('/api/auth/login', { body: { email: 'ausente@example.test', password: ADMIN_PASSWORD } });
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(unknownUser.body).toEqual(wrongPassword.body);
    expectNoCredentials(wrongPassword.body);
    await fixture.login();
  });

  it('exige Bearer válido para dados e alterações, mantendo somente health público', async () => {
    const fixture = await createFixture();
    expect((await fixture.request('/api/health')).status).toBe(200);
    for (const path of ['/api/state', '/api/auth/me']) {
      expect((await fixture.request(path)).status).toBe(401);
      expect((await fixture.request(path, { token: 'token-invalido' })).status).toBe(401);
    }
    const writes = [
      ['/api/commands', { command: { type: 'assign', deliveryId: 'e5', driverId: 'd1' }, revision: 0 }],
      ['/api/users', { user: { id: 'outsider', name: 'Teste', email: 'outsider@example.test', role: 'admin', active: true }, password: USER_PASSWORD }],
      ['/api/auth/logout', {}],
    ] as const;
    for (const [path, body] of writes) expect((await fixture.request(path, { method: 'POST', body })).status).toBe(401);
  });

  it('retorna apenas dados públicos do usuário e nunca credenciais no estado', async () => {
    const fixture = await createFixture();
    const login = await fixture.login();
    expectNoCredentials(login.user);
    const session = await fixture.request('/api/auth/me', { token: login.token });
    expect(session.status).toBe(200);
    expectNoCredentials(session.body);
    const snapshot = await fixture.state(login.token);
    expectNoCredentials(snapshot);
    const responseText = JSON.stringify(snapshot);
    expect(responseText).not.toContain(ADMIN_PASSWORD);
    expect(responseText).not.toContain(DRIVER_PASSWORD);
    expect(responseText).not.toContain(login.token);
  });

  it('persiste somente hashes de senha e token, sem os valores utilizáveis no banco', async () => {
    const databasePath = temporaryDatabase();
    const fixture = await createFixture({ databasePath });
    const login = await fixture.login();
    await fixture.close();
    const contents = readFileSync(databasePath).toString('utf8');
    expect(contents).not.toContain(ADMIN_PASSWORD);
    expect(contents).not.toContain(DRIVER_PASSWORD);
    expect(contents).not.toContain(login.token);
    expect(contents).toContain('password_hash');
    expect(contents).toContain('token_hash');
  });

  it('encerra a sessão e impede reutilização do token após logout', async () => {
    const fixture = await createFixture();
    const login = await fixture.login();
    const logout = await fixture.request('/api/auth/logout', { token: login.token, method: 'POST' });
    expect(logout.status).toBe(204);
    expect(logout.body).toBeNull();
    expect((await fixture.request('/api/state', { token: login.token })).status).toBe(401);
    expect((await fixture.request('/api/auth/me', { token: login.token })).status).toBe(401);
  });

  it('expira sessões no prazo configurado, mesmo que o navegador ainda guarde o token', async () => {
    let now = NOW;
    const fixture = await createFixture({ sessionTtlMs: 1_000, now: () => now });
    const login = await fixture.login();
    now += 999;
    expect((await fixture.request('/api/state', { token: login.token })).status).toBe(200);
    now += 1;
    expect((await fixture.request('/api/state', { token: login.token })).status).toBe(401);
    expect((await fixture.request('/api/auth/me', { token: login.token })).status).toBe(401);
  });

  it('limita tentativas repetidas de login inválido', async () => {
    const fixture = await createFixture();
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await fixture.request('/api/auth/login', { body: { email: ADMIN_EMAIL, password: 'senha-incorreta-de-teste' } })).status).toBe(401);
    }
    const limited = await fixture.request('/api/auth/login', { body: { email: ADMIN_EMAIL, password: 'senha-incorreta-de-teste' } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });
});

describe('API: papéis e isolamento entre entregadores', () => {
  it('entregador recebe apenas seu perfil, suas entregas e seu histórico', async () => {
    const fixture = await createFixture();
    const admin = await fixture.login();
    const driver = await fixture.login(DRIVER_EMAIL, DRIVER_PASSWORD);
    const full = await fixture.state(admin.token);
    const own = await fixture.state(driver.token);
    expect(own.revision).toBe(full.revision);
    expect(own.state.users).toEqual([driver.user]);
    expect(own.state.drivers.map(item => item.id)).toEqual(['d1']);
    expect(own.state.deliveries.length).toBeGreaterThan(0);
    expect(own.state.deliveries.every(item => item.driverId === 'd1')).toBe(true);
    expect(own.state.trips.every(item => item.driverId === 'd1')).toBe(true);
    expect(own.state.deliveries.some(item => item.id === 'e2')).toBe(false);
    expect(JSON.stringify(own)).not.toContain('Bruno Ferreira');
    expectNoCredentials(own);
  });

  it('nega ao entregador comandos administrativos e alterações em outro entregador', async () => {
    const fixture = await createFixture();
    const admin = await fixture.login();
    const driver = await fixture.login(DRIVER_EMAIL, DRIVER_PASSWORD);
    const before = await fixture.state(admin.token);
    const forbidden: Command[] = [
      { type: 'assign', deliveryId: 'e5', driverId: 'd1' },
      { type: 'start', deliveryId: 'e3', driverId: 'd3' },
      { type: 'start', deliveryId: 'e3', driverId: 'd1' },
      { type: 'advance', deliveryId: 'e2' },
      { type: 'complete', deliveryId: 'e2', receivedBy: 'Pessoa de teste' },
      { type: 'availability', driverId: 'd3', online: false },
      { type: 'toggle-user', id: 'u5' },
      { type: 'save-user', user: { ...driver.user, role: 'admin' } },
      { type: 'reset' },
    ];
    for (const command of forbidden) {
      expect((await fixture.command(driver.token, command, before.revision)).status).toBe(403);
    }
    expect((await fixture.saveUser(driver.token, { ...driver.user, role: 'admin' })).status).toBe(403);
    const after = await fixture.state(admin.token);
    expect(after).toEqual(before);
  });

  it('gestor acompanha o painel e atribui entregas, mas não gerencia usuários nem dirige', async () => {
    const fixture = await createFixture();
    const admin = await fixture.login();
    const managerUser = await createUser(fixture, admin.token, 'manager', 'manager-test');
    const manager = await fixture.login(managerUser.email, USER_PASSWORD);
    const state = await fixture.state(manager.token);
    expect(state.state.drivers.length).toBe(4);
    expect(state.state.deliveries.length).toBe(12);
    const assignment = await fixture.command(manager.token, { type: 'assign', deliveryId: 'e5', driverId: 'd3' });
    expect(assignment.status).toBe(200);
    expect(assignment.body!.state.deliveries.find(item => item.id === 'e5')?.driverId).toBe('d3');
    expect((await fixture.command(manager.token, { type: 'start', deliveryId: 'e3', driverId: 'd3' })).status).toBe(403);
    expect((await fixture.command(manager.token, { type: 'toggle-user', id: 'u3' })).status).toBe(403);
    expect((await fixture.saveUser(manager.token, { ...managerUser, role: 'admin' })).status).toBe(403);
  });
});

describe('API: entrega compartilhada e concorrência', () => {
  it('o painel vê o percurso, quilômetros e confirmação enviados pela sessão do entregador', async () => {
    const fixture = await createFixture();
    const admin = await fixture.login();
    const driver = await fixture.login(DRIVER_EMAIL, DRIVER_PASSWORD);
    const before = await fixture.state(admin.token);
    const initialKm = before.state.drivers.find(item => item.id === 'd1')!.kmToday;
    expect((await fixture.command(driver.token, { type: 'start', deliveryId: 'e1', driverId: 'd1' })).status).toBe(200);
    const started = await fixture.state(admin.token);
    expect(started.state.deliveries.find(item => item.id === 'e1')?.status).toBe('in_transit');
    expect(started.state.drivers.find(item => item.id === 'd1')?.status).toBe('on_route');
    expect((await fixture.command(driver.token, { type: 'complete', deliveryId: 'e1', receivedBy: 'Portaria de teste' })).status).toBe(422);
    expect((await fixture.command(driver.token, { type: 'availability', driverId: 'd1', online: false })).status).toBe(422);
    for (let step = 0; step < 4; step++) {
      const advance = await fixture.command(driver.token, { type: 'advance', deliveryId: 'e1' });
      expect(advance.status).toBe(200);
      const polled = await fixture.state(admin.token);
      expect(polled.state.drivers.find(item => item.id === 'd1')!.kmToday).toBeCloseTo(initialKm + 3.8 * ((step + 1) / 4));
    }
    expect((await fixture.command(driver.token, { type: 'complete', deliveryId: 'e1', receivedBy: '  Portaria de teste  ' })).status).toBe(200);
    const completed = await fixture.state(admin.token);
    expect(completed.state.deliveries.find(item => item.id === 'e1')).toMatchObject({ status: 'delivered', receivedBy: 'Portaria de teste' });
    const trip = completed.state.trips.find(item => item.deliveryId === 'e1')!;
    expect(trip.km).toBeCloseTo(3.8);
    expect(trip.progress).toBe(1);
    expect(trip.finishedAt).toBeTruthy();
    expect(completed.state.drivers.find(item => item.id === 'd1')?.status).toBe('available');
    expect((await fixture.command(driver.token, { type: 'complete', deliveryId: 'e1', receivedBy: 'Portaria de teste' })).status).toBe(422);
    expect((await fixture.state(admin.token)).revision).toBe(completed.revision);
    expect((await fixture.state(admin.token)).state.drivers.find(item => item.id === 'd1')!.kmToday).toBeCloseTo(initialKm + 3.8);
  });

  it('retorna conflito para uma tela desatualizada sem sobrescrever alteração recente', async () => {
    const fixture = await createFixture();
    const first = await fixture.login();
    const second = await fixture.login();
    const before = await fixture.state(first.token);
    expect((await fixture.command(first.token, { type: 'assign', deliveryId: 'e5', driverId: 'd3' }, before.revision)).status).toBe(200);
    const current = await fixture.state(first.token);
    const stale = await fixture.command(second.token, { type: 'assign', deliveryId: 'e5', driverId: 'd1' }, before.revision);
    expect(stale.status).toBe(409);
    expect(await fixture.state(second.token)).toEqual(current);
  });

  it('preserva dados e credenciais ao reiniciar o serviço com o mesmo SQLite', async () => {
    const databasePath = temporaryDatabase();
    const fixture = await createFixture({ databasePath });
    const admin = await fixture.login();
    const newDriver = await createUser(fixture, admin.token);
    const assignment = await fixture.command(admin.token, { type: 'assign', deliveryId: 'e5', driverId: newDriver.driverId! });
    expect(assignment.status).toBe(200);
    const before = await fixture.state(admin.token);
    await fixture.close();
    const restarted = await createFixture({ databasePath, demoSeed: false, adminPassword: 'Senha-diferente-no-restart-2026' });
    const sameAdmin = await restarted.login();
    expect(await restarted.state(sameAdmin.token)).toMatchObject({ revision: before.revision, state: before.state, simulation: true });
    const driver = await restarted.login(newDriver.email, USER_PASSWORD);
    const own = await restarted.state(driver.token);
    expect(own.state.drivers.map(item => item.id)).toEqual([newDriver.driverId]);
    expect(own.state.deliveries.map(item => item.id)).toEqual(['e5']);
  });

  it('não converte banco operacional em demonstração nem habilita quilômetros simulados ao reiniciar', async () => {
    const databasePath = temporaryDatabase();
    const fixture = await createFixture({ databasePath, demoSeed: false });
    const admin = await fixture.login();
    const before = await fixture.state(admin.token);
    expect((await fixture.command(admin.token, { type: 'advance', deliveryId: 'qualquer-entrega' })).status).toBe(403);
    await fixture.close();
    const restarted = await createFixture({ databasePath, demoSeed: true });
    const login = await restarted.login();
    expect(await restarted.state(login.token)).toEqual(before);
    expect((await restarted.command(login.token, { type: 'advance', deliveryId: 'qualquer-entrega' })).status).toBe(403);
    expect((await restarted.state(login.token)).simulation).toBe(false);
  });
});

describe('API: gestão de usuários', () => {
  it('cadastro de entregador cria perfil próprio e senha, sem expor dados de outros usuários', async () => {
    const fixture = await createFixture();
    const admin = await fixture.login();
    const user = await createUser(fixture, admin.token);
    expect(user.driverId).toBeTruthy();
    const login = await fixture.login(user.email, USER_PASSWORD);
    const snapshot = await fixture.state(login.token);
    expect(snapshot.state.users).toEqual([user]);
    expect(snapshot.state.deliveries).toEqual([]);
    expect(snapshot.state.trips).toEqual([]);
    expect(snapshot.state.drivers).toHaveLength(1);
    expect(snapshot.state.drivers[0]).toMatchObject({ id: user.driverId, name: user.name, status: 'offline' });
    expectNoCredentials(snapshot);
  });

  it('exige senha inicial válida, rejeita e-mail duplicado e não incrementa a revisão em falhas', async () => {
    const fixture = await createFixture();
    const admin = await fixture.login();
    const before = await fixture.state(admin.token);
    const user: AppUser = { id: 'sem-senha', name: 'Teste', email: 'sem-senha@example.test', role: 'manager', active: true };
    expect((await fixture.saveUser(admin.token, user)).status).toBe(400);
    expect((await fixture.saveUser(admin.token, user, 'curta')).status).toBe(400);
    expect((await fixture.saveUser(admin.token, { ...user, email: ADMIN_EMAIL }, USER_PASSWORD)).status).toBe(422);
    expect(await fixture.state(admin.token)).toEqual(before);
  });

  it('mudar a senha revoga sessões anteriores e torna a senha antiga inválida', async () => {
    const fixture = await createFixture();
    const admin = await fixture.login();
    const user = await createUser(fixture, admin.token);
    const previous = await fixture.login(user.email, USER_PASSWORD);
    const newPassword = 'Nova-senha-de-teste-2026';
    expect((await fixture.saveUser(admin.token, user, newPassword)).status).toBe(200);
    expect((await fixture.request('/api/state', { token: previous.token })).status).toBe(401);
    expect((await fixture.request('/api/auth/login', { body: { email: user.email, password: USER_PASSWORD } })).status).toBe(401);
    const current = await fixture.login(user.email, newPassword);
    expect((await fixture.request('/api/state', { token: current.token })).status).toBe(200);
  });

  it('alterar papel revoga sessões e aplica permissões novas no login seguinte', async () => {
    const fixture = await createFixture();
    const admin = await fixture.login();
    const user = await createUser(fixture, admin.token);
    const previous = await fixture.login(user.email, USER_PASSWORD);
    expect((await fixture.saveUser(admin.token, { ...user, role: 'manager' })).status).toBe(200);
    expect((await fixture.request('/api/state', { token: previous.token })).status).toBe(401);
    const current = await fixture.login(user.email, USER_PASSWORD);
    expect(current.user.role).toBe('manager');
    expect((await fixture.state(current.token)).state.drivers.length).toBe(5);
    expect((await fixture.saveUser(current.token, { ...current.user, role: 'admin' })).status).toBe(403);
  });

  it('desativação revoga a sessão, nega novo login e encerra disponibilidade do entregador', async () => {
    const fixture = await createFixture();
    const admin = await fixture.login();
    const user = await createUser(fixture, admin.token);
    const previous = await fixture.login(user.email, USER_PASSWORD);
    expect((await fixture.command(previous.token, { type: 'availability', driverId: user.driverId!, online: true })).status).toBe(200);
    expect((await fixture.command(admin.token, { type: 'toggle-user', id: user.id })).status).toBe(200);
    expect((await fixture.request('/api/state', { token: previous.token })).status).toBe(401);
    expect((await fixture.request('/api/auth/login', { body: { email: user.email, password: USER_PASSWORD } })).status).toBe(401);
    const snapshot = await fixture.state(admin.token);
    expect(snapshot.state.users.find(item => item.id === user.id)?.active).toBe(false);
    expect(snapshot.state.drivers.find(item => item.id === user.driverId)?.status).toBe('offline');
  });

  it('protege o último administrador de desativação e mudança de papel', async () => {
    const fixture = await createFixture();
    const admin = await fixture.login();
    const before = await fixture.state(admin.token);
    expect((await fixture.command(admin.token, { type: 'toggle-user', id: admin.user.id })).status).toBe(422);
    expect((await fixture.saveUser(admin.token, { ...admin.user, active: false })).status).toBe(422);
    expect((await fixture.saveUser(admin.token, { ...admin.user, role: 'manager' })).status).toBe(422);
    expect(await fixture.state(admin.token)).toEqual(before);
  });
});

describe('API: validação HTTP', () => {
  it('recusa JSON malformado, campos inesperados e valores inválidos sem alterar dados', async () => {
    const fixture = await createFixture();
    const admin = await fixture.login();
    const before = await fixture.state(admin.token);
    expect((await fixture.request('/api/commands', { token: admin.token, raw: '{invalid' })).status).toBe(400);
    const invalidBodies = [
      null,
      [],
      { command: { type: 'assign', deliveryId: 'e5', driverId: 'd1' } },
      { command: { type: 'assign', deliveryId: 'e5', driverId: 'd1' }, revision: -1 },
      { command: { type: 'assign', deliveryId: 'e5', driverId: 'd1', bypass: true }, revision: before.revision },
      { command: { type: 'assign', deliveryId: 'e5', driverId: 'd1' }, revision: before.revision, admin: true },
      { command: { type: 'availability', driverId: 'd1', online: 'true' }, revision: before.revision },
      { command: { type: 'missing' }, revision: before.revision },
    ];
    for (const body of invalidBodies) expect((await fixture.request('/api/commands', { token: admin.token, body })).status).toBe(400);
    expect(await fixture.state(admin.token)).toEqual(before);
  });

  it('limita o tamanho dos pedidos e retorna 404 para rotas desconhecidas da API', async () => {
    const fixture = await createFixture();
    const admin = await fixture.login();
    const tooLarge = await fixture.request('/api/commands', { token: admin.token, body: { text: 'x'.repeat(300_000) } });
    expect(tooLarge.status).toBe(413);
    expectNoCredentials(tooLarge.body);
    expect((await fixture.request('/api/missing', { token: admin.token })).status).toBe(404);
    expect((await fixture.request('/api/state-extra', { token: admin.token })).status).toBe(404);
    expect((await fixture.request('/api/state', { token: admin.token })).status).toBe(200);
  });

  it('responde 413 a um pedido chunked grande, sem encerrar a conexão antes da resposta', async () => {
    const fixture = await createFixture();
    const admin = await fixture.login();
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(new URL('/api/commands', fixture.origin), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
      }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode!));
        response.on('error', reject);
      });
      request.on('error', reject);
      const body = JSON.stringify({ text: 'x'.repeat(100_000) });
      // Multiple writes without Content-Length exercise streaming size checks.
      for (let offset = 0; offset < body.length; offset += 16_384) request.write(body.slice(offset, offset + 16_384));
      request.end();
    });
    expect(status).toBe(413);
    expect((await fixture.request('/api/state', { token: admin.token })).status).toBe(200);
  });
});

describe('Servidor: interface compilada', () => {
  it('serve o painel e o entregador como SPA, preservando assets e erros JSON da API', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rota-static-test-'));
    directories.push(directory);
    const html = '<!doctype html><html><body>Interface de teste</body></html>';
    const script = 'window.rotaStaticTest = true;';
    mkdirSync(join(directory, 'assets'));
    writeFileSync(join(directory, 'index.html'), html);
    writeFileSync(join(directory, 'assets', 'app.js'), script);
    const fixture = await createFixture({ staticDir: directory });
    for (const path of ['/', '/entregador']) {
      const response = await fetch(`${fixture.origin}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toBe(html);
    }
    const asset = await fetch(`${fixture.origin}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(await asset.text()).toBe(script);
    const unknownApi = await fixture.request('/api/desconhecida');
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.headers.get('content-type')).toContain('application/json');
    expect(unknownApi.body?.error).toBeTruthy();
    expect(JSON.stringify(unknownApi.body)).not.toContain(html);
  });

  it('nega traversal e symlinks para arquivos fora da distribuição', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rota-static-test-'));
    directories.push(directory);
    const distribution = join(directory, 'public');
    const externalContent = 'Conteúdo externo privado de teste';
    mkdirSync(distribution);
    writeFileSync(join(distribution, 'index.html'), '<html>Interface</html>');
    writeFileSync(join(directory, 'outside.txt'), externalContent);
    symlinkSync(join(directory, 'outside.txt'), join(distribution, 'linked.txt'));
    const fixture = await createFixture({ staticDir: distribution });
    const linked = await fixture.request('/linked.txt');
    expect(linked.status).toBe(404);
    expect(JSON.stringify(linked.body)).not.toContain(externalContent);
    const traversal = await fixture.request('/%2e%2e%2foutside.txt');
    expect(traversal.status).toBe(400);
    expect(JSON.stringify(traversal.body)).not.toContain(externalContent);
  });
});
