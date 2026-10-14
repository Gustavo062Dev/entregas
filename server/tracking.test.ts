import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApiServer } from './app.ts';
import type { Command } from '../src/domain.ts';
import type { AppState, AppUser, Delivery, GpsPoint, TrackingSession } from '../src/types.ts';

// Disposable credentials used exclusively in isolated test databases.
const ADMIN_EMAIL = 'tracking-admin@example.test';
const ADMIN_PASSWORD = 'Tracking-admin-test-2026';
const USER_PASSWORD = 'Tracking-user-test-2026';
const BASE_TIME = Date.parse('2026-10-13T14:00:00Z');
const LATITUDE = -23.55052;
const LONGITUDE = -46.633308;
interface Snapshot { state: AppState; revision: number; simulation: boolean }
interface TrackingSnapshot extends Snapshot { trackingSession: TrackingSession }
interface PointsSnapshot extends Snapshot { active: boolean; ackIds: string[]; accepted: number; rejected: number; duplicates: number }
interface Login { token: string; user: AppUser }
interface Response<T> { status: number; body: T }
interface RequestOptions { token?: string; body?: unknown; method?: string; headers?: Record<string, string> }
type ApiOptions = NonNullable<Parameters<typeof createApiServer>[0]>;
interface Fixture {
  server: Server;
  request: <T = { error: string }>(path: string, options?: RequestOptions) => Promise<Response<T>>;
  state: (token: string) => Promise<Snapshot>;
  login: (email?: string, password?: string) => Promise<Login>;
  command: (token: string, command: Command) => Promise<Response<Snapshot>>;
  close: () => Promise<void>;
}
const fixtures: Fixture[] = [];
const directories: string[] = [];

async function fixture(clock: { now: number }, options: ApiOptions = {}): Promise<Fixture> {
  const server = createApiServer({ databasePath: ':memory:', adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASSWORD,
    demoSeed: false, now: () => clock.now, ...options });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request: Fixture['request'] = async <T>(path: string, options: RequestOptions = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: { ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return { status: response.status, body: await response.json() as T };
  };
  const result: Fixture = {
    server, request,
    async state(token) {
      const response = await request<Snapshot>('/api/state', { token });
      expect(response.status).toBe(200);
      return response.body;
    },
    async login(email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
      const response = await request<Login>('/api/auth/login', { body: { email, password } });
      expect(response.status).toBe(200);
      return response.body;
    },
    async command(token, command) {
      const { revision } = await result.state(token);
      return request<Snapshot>('/api/commands', { token, body: { command, revision } });
    },
    async close() {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
  fixtures.push(result);
  return result;
}

async function createUser(api: Fixture, admin: Login, role: AppUser['role'] = 'driver'): Promise<Login> {
  const id = randomUUID();
  const response = await api.request<Snapshot>('/api/users', { token: admin.token,
    body: { user: { id, name: 'Usuário GPS de teste', email: `${id}@example.test`, role, active: true }, password: USER_PASSWORD } });
  expect(response.status).toBe(200);
  const user = response.body.state.users.find(item => item.id === id)!;
  return api.login(user.email, USER_PASSWORD);
}

async function onlineDriver(api: Fixture, admin?: Login) {
  const user = await createUser(api, admin ?? await api.login());
  expect((await api.command(user.token, { type: 'availability', driverId: user.user.driverId!, online: true })).status).toBe(200);
  return user;
}

async function start(api: Fixture, driver: Login, deviceId = randomUUID()) {
  const response = await api.request<TrackingSnapshot>('/api/tracking/start', { token: driver.token, body: { deviceId } });
  expect(response.status).toBe(200);
  expect(response.body.simulation).toBe(false);
  return response.body;
}

function point(time: number, latitude = LATITUDE, overrides: Partial<GpsPoint> = {}): GpsPoint {
  return { id: randomUUID(), latitude, longitude: LONGITUDE, accuracy: 5,
    recordedAt: new Date(time).toISOString(), ...overrides };
}

function points(api: Fixture, driver: Login, sessionId: string, samples: GpsPoint[]) {
  return api.request<PointsSnapshot>('/api/tracking/points', { token: driver.token, body: { sessionId, points: samples } });
}

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'rota-tracking-test-'));
  directories.push(directory);
  return join(directory, 'rota.sqlite');
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(api => api.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('API GPS: papéis, turno e propriedade das sessões', () => {
  it('exige autenticação e permite iniciar coleta somente ao próprio entregador em turno', async () => {
    const clock = { now: BASE_TIME };
    const api = await fixture(clock);
    const admin = await api.login();
    const manager = await createUser(api, admin, 'manager');
    const driver = await createUser(api, admin);
    for (const token of [undefined, admin.token, manager.token, driver.token]) {
      const response = await api.request('/api/tracking/start', { token, body: { deviceId: randomUUID() } });
      expect(response.status).toBe(token === undefined ? 401 : 403);
    }
    expect((await api.command(driver.token, { type: 'availability', driverId: driver.user.driverId!, online: true })).status).toBe(200);
    const started = await start(api, driver);
    expect(started.trackingSession).toMatchObject({ driverId: driver.user.driverId, meters: 0, acceptedPoints: 0 });
  });

  it('a mesma instalação retoma a sessão e outra instalação não coleta ao mesmo tempo', async () => {
    const clock = { now: BASE_TIME };
    const api = await fixture(clock);
    const driver = await onlineDriver(api);
    const deviceId = randomUUID();
    const first = await start(api, driver, deviceId);
    const retry = await start(api, driver, deviceId);
    expect(retry).toEqual(first);
    expect((await api.request('/api/tracking/start', { token: driver.token, body: { deviceId: randomUUID() } })).status).toBe(409);
    expect(await api.state(driver.token)).toMatchObject({ revision: first.revision });
  });

  it('nenhuma sessão pode receber pontos ou ser encerrada por outro entregador ou administrador', async () => {
    const clock = { now: BASE_TIME };
    const api = await fixture(clock);
    const admin = await api.login();
    const owner = await onlineDriver(api, admin);
    const other = await onlineDriver(api, admin);
    const ownSession = await start(api, owner);
    await start(api, other);
    for (const account of [admin, other]) {
      expect((await points(api, account, ownSession.trackingSession.id, [point(BASE_TIME)])).status).toBe(403);
      expect((await api.request('/api/tracking/stop', { token: account.token,
        body: { sessionId: ownSession.trackingSession.id } })).status).toBe(403);
    }
    const otherState = (await api.state(other.token)).state;
    expect(otherState.trackingSessions!.every(item => item.driverId === other.user.driverId)).toBe(true);
    expect(otherState.gpsDays?.every(item => item.driverId === other.user.driverId) ?? true).toBe(true);
    expect(JSON.stringify(otherState)).not.toContain(ownSession.trackingSession.id);
    expect((await api.state(owner.token)).revision).toBe((await api.state(admin.token)).revision);
  });

  it('não mistura coleta real com uma base de demonstração', async () => {
    const clock = { now: BASE_TIME };
    const api = await fixture(clock, { demoSeed: true });
    const driver = await onlineDriver(api);
    const before = await api.state(driver.token);
    expect(before.simulation).toBe(true);
    expect((await api.request('/api/tracking/start', { token: driver.token, body: { deviceId: randomUUID() } })).status).toBe(403);
    expect((await points(api, driver, randomUUID(), [point(BASE_TIME)])).status).toBe(403);
    expect((await api.request('/api/tracking/stop', { token: driver.token, body: { sessionId: randomUUID() } })).status).toBe(403);
    expect(await api.state(driver.token)).toEqual(before);
  });

  it('trocar a conta vinculada ao entregador não transfere acesso à sessão de GPS anterior', async () => {
    const clock = { now: BASE_TIME };
    const api = await fixture(clock);
    const admin = await api.login();
    const original = await onlineDriver(api, admin);
    const { trackingSession } = await start(api, original);
    expect((await points(api, original, trackingSession.id, [point(BASE_TIME)])).status).toBe(200);
    clock.now += 10_000;
    expect((await api.request('/api/users', { token: admin.token,
      body: { user: { ...original.user, role: 'manager', driverId: undefined } } })).status).toBe(200);
    const newUser: AppUser = { id: randomUUID(), name: 'Nova conta de teste', email: 'replacement@example.test',
      role: 'driver', active: true, driverId: original.user.driverId };
    expect((await api.request('/api/users', { token: admin.token, body: { user: newUser, password: USER_PASSWORD } })).status).toBe(200);
    const replacement = await api.login(newUser.email, USER_PASSWORD);
    expect((await api.command(replacement.token, { type: 'availability', driverId: original.user.driverId!, online: true })).status).toBe(200);
    const visible = await api.state(replacement.token);
    expect(visible.state.trackingSessions ?? []).toEqual([]);
    expect((await points(api, replacement, trackingSession.id, [point(BASE_TIME + 5_000)])).status).toBe(403);
    expect((await api.request('/api/tracking/stop', { token: replacement.token, body: { sessionId: trackingSession.id } })).status).toBe(403);
    const newSession = await start(api, replacement);
    expect(newSession.trackingSession.id).not.toBe(trackingSession.id);
  });
});

describe('API GPS: lote persistente, confirmação e distância confiável', () => {
  it('envia confirmações compactas ao Android mesmo com histórico acima de 256 KiB', async () => {
    const clock = { now: BASE_TIME };
    const databasePath = temporaryDatabase();
    const api = await fixture(clock, { databasePath });
    const driver = await onlineDriver(api);
    const { trackingSession } = await start(api, driver);
    const db = new DatabaseSync(databasePath);
    const row = db.prepare('SELECT data FROM app_state WHERE id = 1').get() as { data: string };
    const seeded = JSON.parse(row.data) as AppState;
    const pastPoint = point(BASE_TIME - 2000);
    const bind = db.prepare('INSERT INTO tracking_owners (session_id, user_id) VALUES (?, ?)');
    for (let index = 0; index < 550; index++) {
      const id = randomUUID();
      seeded.trackingSessions!.push({ ...trackingSession, id, startedAt: new Date(BASE_TIME - 86_400_000).toISOString(),
        endedAt: new Date(BASE_TIME - 1000).toISOString(), lastPoint: pastPoint, anchor: pastPoint });
      bind.run(id, driver.user.id);
    }
    db.prepare('UPDATE app_state SET data = ? WHERE id = 1').run(JSON.stringify(seeded));
    db.close();
    const full = await api.state(driver.token);
    expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(262144);
    clock.now += 10_000;
    const samples = [point(BASE_TIME), point(clock.now, LATITUDE + .001)];
    const headers = { 'X-Rota-Tracking-Response': 'compact' };
    const result = await api.request<Omit<PointsSnapshot, 'state'>>('/api/tracking/points', { token: driver.token, headers,
      body: { sessionId: trackingSession.id, points: samples } });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ackIds: samples.map(item => item.id), accepted: 2, active: true });
    expect(result.body).not.toHaveProperty('state');
    expect(Buffer.byteLength(JSON.stringify(result.body))).toBeLessThan(2048);
    expect((await api.state(driver.token)).state.drivers[0].kmToday).toBeGreaterThan(.1);
    const stopped = await api.request<Omit<TrackingSnapshot, 'state'>>('/api/tracking/stop', { token: driver.token, headers,
      body: { sessionId: trackingSession.id } });
    expect(stopped.status).toBe(200);
    expect(stopped.body.trackingSession.endedAt).toBe(new Date(clock.now).toISOString());
    expect(stopped.body).not.toHaveProperty('state');
    expect(Buffer.byteLength(JSON.stringify(stopped.body))).toBeLessThan(2048);
  });
  it('o painel recebe coordenadas reais e a distância medida, sem usar posições ilustrativas', async () => {
    const clock = { now: BASE_TIME };
    const api = await fixture(clock);
    const admin = await api.login();
    const driver = await onlineDriver(api, admin);
    const started = await start(api, driver);
    const samples = [point(BASE_TIME), point(BASE_TIME + 10_000, LATITUDE + 0.001)];
    clock.now += 10_000;
    const response = await points(api, driver, started.trackingSession.id, samples);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ accepted: 2, rejected: 0, duplicates: 0, ackIds: samples.map(item => item.id) });
    const full = (await api.state(admin.token)).state;
    const trackedDriver = full.drivers.find(item => item.id === driver.user.driverId)!;
    expect(trackedDriver.gps).toMatchObject(samples[1]);
    expect(trackedDriver.gps!.receivedAt).toBe(new Date(clock.now).toISOString());
    expect(trackedDriver.kmToday).toBeCloseTo(0.111195, 5);
    expect(full.gpsDays).toHaveLength(1);
    expect(full.gpsDays![0]).toMatchObject({ driverId: driver.user.driverId, date: '2026-10-13', acceptedPoints: 2, gaps: 0 });
    expect(full.gpsDays![0].meters).toBeCloseTo(111.195, 2);
  });

  it('reenvio de um lote confirmado não soma distância, pontos ou revisão novamente', async () => {
    const clock = { now: BASE_TIME };
    const api = await fixture(clock);
    const driver = await onlineDriver(api);
    const { trackingSession } = await start(api, driver);
    const samples = [point(BASE_TIME), point(BASE_TIME + 10_000, LATITUDE + 0.001)];
    clock.now += 10_000;
    const first = await points(api, driver, trackingSession.id, samples);
    expect(first.status).toBe(200);
    const before = await api.state(driver.token);
    const retry = await points(api, driver, trackingSession.id, samples);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ ackIds: samples.map(item => item.id), accepted: 0, rejected: 0, duplicates: 2, revision: before.revision });
    expect(await api.state(driver.token)).toEqual(before);
  });

  it('um identificador reutilizado com coordenadas diferentes rejeita o lote inteiro atomicamente', async () => {
    const clock = { now: BASE_TIME };
    const api = await fixture(clock);
    const driver = await onlineDriver(api);
    const { trackingSession } = await start(api, driver);
    const first = point(BASE_TIME);
    expect((await points(api, driver, trackingSession.id, [first])).status).toBe(200);
    clock.now += 20_000;
    const next = point(BASE_TIME + 10_000, LATITUDE + 0.001);
    const changed = { ...first, latitude: LATITUDE + 0.002, recordedAt: new Date(clock.now).toISOString() };
    const before = await api.state(driver.token);
    expect((await points(api, driver, trackingSession.id, [next, changed])).status).toBe(409);
    expect(await api.state(driver.token)).toEqual(before);
    const retryValid = await points(api, driver, trackingSession.id, [next]);
    expect(retryValid.status).toBe(200);
    expect(retryValid.body).toMatchObject({ accepted: 1, duplicates: 0, ackIds: [next.id] });
  });

  it('confirma amostras imprecisas, teletransporte e fora de ordem sem contabilizar quilômetros', async () => {
    const clock = { now: BASE_TIME };
    const api = await fixture(clock);
    const driver = await onlineDriver(api);
    const { trackingSession } = await start(api, driver);
    const first = point(BASE_TIME);
    expect((await points(api, driver, trackingSession.id, [first])).status).toBe(200);
    const invalidQuality = [point(BASE_TIME + 10_000, LATITUDE + 0.001, { accuracy: 70 }),
      point(BASE_TIME + 20_000, LATITUDE + 1), point(BASE_TIME, LATITUDE + 0.002)];
    clock.now += 20_000;
    for (const sample of invalidQuality) {
      const response = await points(api, driver, trackingSession.id, [sample]);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ackIds: [sample.id], accepted: 0, rejected: 1, duplicates: 0 });
    }
    const state = (await api.state(driver.token)).state;
    expect(state.trackingSessions![0]).toMatchObject({ meters: 0, acceptedPoints: 1, rejectedPoints: 3, lastPoint: first });
    expect(state.drivers[0].gps).toMatchObject(first);
    expect(state.drivers[0].kmToday).toBe(0);
    const retry = await points(api, driver, trackingSession.id, invalidQuality);
    expect(retry.body).toMatchObject({ accepted: 0, rejected: 0, duplicates: 3 });
  });

  it('uma lacuna sem GPS fica registrada e não gera uma reta artificial de quilômetros', async () => {
    const clock = { now: BASE_TIME };
    const api = await fixture(clock);
    const driver = await onlineDriver(api);
    const { trackingSession } = await start(api, driver);
    const samples = [point(BASE_TIME), point(BASE_TIME + 121_000, LATITUDE + 0.05),
      point(BASE_TIME + 131_000, LATITUDE + 0.051)];
    clock.now += 131_000;
    expect((await points(api, driver, trackingSession.id, samples)).status).toBe(200);
    const state = (await api.state(driver.token)).state;
    expect(state.trackingSessions![0]).toMatchObject({ acceptedPoints: 3, gaps: 1 });
    expect(state.trackingSessions![0].meters).toBeCloseTo(111.195, 2);
    expect(state.gpsDays![0].gaps).toBe(1);
    expect(state.drivers[0].kmToday).toBeCloseTo(0.111195, 5);
  });

  it('mantém distância, deduplicação, localização e encerramento depois de reiniciar o SQLite', async () => {
    const clock = { now: BASE_TIME };
    const databasePath = temporaryDatabase();
    const api = await fixture(clock, { databasePath });
    const driver = await onlineDriver(api);
    const { trackingSession } = await start(api, driver);
    const samples = [point(BASE_TIME), point(BASE_TIME + 10_000, LATITUDE + 0.001)];
    clock.now += 10_000;
    expect((await points(api, driver, trackingSession.id, samples)).status).toBe(200);
    expect((await api.request('/api/tracking/stop', { token: driver.token, body: { sessionId: trackingSession.id } })).status).toBe(200);
    const before = await api.state(driver.token);
    await api.close();
    const restarted = await fixture(clock, { databasePath });
    const sameDriver = await restarted.login(driver.user.email, USER_PASSWORD);
    expect(await restarted.state(sameDriver.token)).toEqual(before);
    const duplicate = await points(restarted, sameDriver, trackingSession.id, samples);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ duplicates: 2, accepted: 0, revision: before.revision });
    expect((await restarted.request('/api/tracking/stop', { token: sameDriver.token,
      body: { sessionId: trackingSession.id } })).status).toBe(200);
    expect(await restarted.state(sameDriver.token)).toEqual(before);
  });

  it('divide um segmento na meia-noite de São Paulo e conta apenas a parte do dia atual', async () => {
    const clock = { now: Date.parse('2026-10-14T02:59:50Z') };
    const api = await fixture(clock);
    const driver = await onlineDriver(api);
    const { trackingSession } = await start(api, driver);
    const samples = [point(clock.now), point(clock.now + 20_000, LATITUDE + 0.001)];
    clock.now += 20_000;
    expect((await points(api, driver, trackingSession.id, samples)).status).toBe(200);
    const state = (await api.state(driver.token)).state;
    expect(state.demoDate).toBe('2026-10-14');
    expect(state.gpsDays!.map(item => item.date).sort()).toEqual(['2026-10-13', '2026-10-14']);
    const beforeMidnight = state.gpsDays!.find(item => item.date === '2026-10-13')!;
    const afterMidnight = state.gpsDays!.find(item => item.date === '2026-10-14')!;
    expect(beforeMidnight.meters).toBeCloseTo(55.5975, 2);
    expect(afterMidnight.meters).toBeCloseTo(55.5975, 2);
    expect(beforeMidnight.meters + afterMidnight.meters).toBeCloseTo(state.trackingSessions![0].meters, 5);
    expect(state.drivers[0].kmToday).toBeCloseTo(afterMidnight.meters / 1_000, 5);
  });
});

describe('API GPS: janela da coleta e entrega operacional', () => {
  it('confirma um lote misto de uma sessão encerrada e contabiliza apenas as capturas dentro da janela', async () => {
    const clock = { now: BASE_TIME };
    const api = await fixture(clock);
    const driver = await onlineDriver(api);
    const { trackingSession } = await start(api, driver);
    clock.now += 20_000;
    expect((await api.request('/api/tracking/stop', { token: driver.token,
      body: { sessionId: trackingSession.id } })).status).toBe(200);
    const cachedBeforeStart = point(BASE_TIME - 1_000, LATITUDE + 0.1);
    const first = point(BASE_TIME);
    const second = point(BASE_TIME + 10_000, LATITUDE + 0.001);
    const capturedAfterStop = point(BASE_TIME + 21_000, LATITUDE + 0.1);
    const samples = [capturedAfterStop, second, cachedBeforeStart, first];
    const response = await points(api, driver, trackingSession.id, samples);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ accepted: 2, rejected: 2, duplicates: 0, active: false });
    expect(response.body.ackIds).toHaveLength(4);
    expect(response.body.ackIds).toEqual(expect.arrayContaining(samples.map(sample => sample.id)));
    expect(response.body.state.trackingSessions![0]).toMatchObject({ acceptedPoints: 2, rejectedPoints: 2 });
    expect(response.body.state.trackingSessions![0].meters).toBeCloseTo(111.195, 2);
    expect(response.body.state.drivers[0].gps).toMatchObject(second);
    expect(response.body.state.drivers[0].kmToday).toBeCloseTo(0.111195, 5);
    const retry = await points(api, driver, trackingSession.id, samples);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ accepted: 0, rejected: 0, duplicates: 4, active: false, revision: response.body.revision });
  });

  it('aceita a fila capturada antes do encerramento sem substituir a localização de uma sessão mais recente', async () => {
    const clock = { now: BASE_TIME };
    const api = await fixture(clock);
    const driver = await onlineDriver(api);
    const oldSession = (await start(api, driver)).trackingSession;
    expect((await points(api, driver, oldSession.id, [point(BASE_TIME)])).status).toBe(200);
    clock.now += 30_000;
    expect((await api.request('/api/tracking/stop', { token: driver.token,
      body: { sessionId: oldSession.id, stoppedAt: new Date(clock.now).toISOString() } })).status).toBe(200);
    clock.now += 20_000;
    const newSession = (await start(api, driver)).trackingSession;
    const newest = point(clock.now + 5_000, LATITUDE + 0.05);
    clock.now += 5_000;
    expect((await points(api, driver, newSession.id, [newest])).status).toBe(200);
    const delayed = point(BASE_TIME + 20_000, LATITUDE + 0.001);
    const response = await points(api, driver, oldSession.id, [delayed]);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ accepted: 1, ackIds: [delayed.id] });
    expect(response.body.state.drivers[0].gps).toMatchObject(newest);
    expect(response.body.state.drivers[0].kmToday).toBeCloseTo(0.111195, 5);
    const oldWindowRejection = await points(api, driver, oldSession.id, [point(BASE_TIME + 31_000)]);
    expect(oldWindowRejection.status).toBe(200);
    expect(oldWindowRejection.body).toMatchObject({ accepted: 0, rejected: 1, active: false });
    const newWindowRejection = await points(api, driver, newSession.id, [point(BASE_TIME + 20_000)]);
    expect(newWindowRejection.status).toBe(200);
    expect(newWindowRejection.body).toMatchObject({ accepted: 0, rejected: 1, active: true });
    expect(newWindowRejection.body.state.drivers[0].gps).toMatchObject(newest);
    expect(newWindowRejection.body.state.drivers[0].kmToday).toBeCloseTo(0.111195, 5);
  });

  it('rejeita limites de encerramento inválidos e encerra a coleta ao sair do turno', async () => {
    const clock = { now: BASE_TIME };
    const api = await fixture(clock);
    const driver = await onlineDriver(api);
    const { trackingSession } = await start(api, driver);
    const before = await api.state(driver.token);
    for (const stoppedAt of [new Date(BASE_TIME - 1_000).toISOString(), new Date(BASE_TIME + 31_000).toISOString()]) {
      expect((await api.request('/api/tracking/stop', { token: driver.token,
        body: { sessionId: trackingSession.id, stoppedAt } })).status).toBe(422);
      expect(await api.state(driver.token)).toEqual(before);
    }
    clock.now += 20_000;
    expect((await api.command(driver.token, { type: 'availability', driverId: driver.user.driverId!, online: false })).status).toBe(200);
    const after = await api.state(driver.token);
    expect(after.state.trackingSessions![0].endedAt).toBe(new Date(clock.now).toISOString());
    expect(after.state.drivers[0].status).toBe('offline');
    const afterShift = await points(api, driver, trackingSession.id, [point(clock.now + 1_000)]);
    expect(afterShift.status).toBe(200);
    expect(afterShift.body).toMatchObject({ accepted: 0, rejected: 1, active: false });
    expect(afterShift.body.state.drivers[0].kmToday).toBe(0);
  });

  it('preserva a última captura ao ajustar um encerramento com diferença de relógio', async () => {
    const clock = { now: BASE_TIME };
    const api = await fixture(clock);
    const driver = await onlineDriver(api);
    const { trackingSession } = await start(api, driver);
    clock.now += 20_000;
    const samples = [point(BASE_TIME), point(clock.now, LATITUDE + 0.001)];
    expect((await points(api, driver, trackingSession.id, samples)).status).toBe(200);
    const before = await api.state(driver.token);
    const stopped = await api.request<TrackingSnapshot>('/api/tracking/stop', { token: driver.token,
      body: { sessionId: trackingSession.id, stoppedAt: new Date(BASE_TIME + 10_000).toISOString() } });
    expect(stopped.status).toBe(200);
    expect(stopped.body.trackingSession.endedAt).toBe(samples[1].recordedAt);
    expect(stopped.body.state.gpsDays).toEqual(before.state.gpsDays);
    expect(stopped.body.trackingSession.lastPoint).toEqual(before.state.trackingSessions![0].lastPoint);
    const future = point(clock.now + 31_000, LATITUDE + 0.002);
    const rejected = await points(api, driver, trackingSession.id, [future]);
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ ackIds: [future.id], accepted: 0, rejected: 1 });
    expect(rejected.body.state.drivers[0].gps).toMatchObject(samples[1]);
  });

  it('rejeita campos de identidade enviados pelo cliente e lotes inválidos sem alterar dados', async () => {
    const clock = { now: BASE_TIME };
    const api = await fixture(clock);
    const driver = await onlineDriver(api);
    const { trackingSession } = await start(api, driver);
    const before = await api.state(driver.token);
    const invalidBodies = [
      { sessionId: trackingSession.id, points: [], driverId: driver.user.driverId },
      { sessionId: trackingSession.id, points: [] },
      { sessionId: trackingSession.id, points: [point(BASE_TIME, 91)] },
      { sessionId: trackingSession.id, points: [point(BASE_TIME, LATITUDE, { id: 'invalid sample id' })] },
      { sessionId: trackingSession.id, points: [point(BASE_TIME, LATITUDE, { longitude: -181 })] },
      { sessionId: trackingSession.id, points: [point(BASE_TIME, LATITUDE, { accuracy: -1 })] },
    ];
    for (const body of invalidBodies) {
      expect((await api.request('/api/tracking/points', { token: driver.token, body })).status).toBe(400);
      expect(await api.state(driver.token)).toEqual(before);
    }
    expect((await api.request('/api/tracking/start', { token: driver.token,
      body: { deviceId: randomUUID(), driverId: driver.user.driverId } })).status).toBe(400);
    expect((await points(api, driver, trackingSession.id, Array.from({ length: 101 }, () => point(BASE_TIME)))).status).toBe(400);
  });

  it('confirma uma entrega operacional manualmente e evita somar a distância GPS duas vezes no total diário', async () => {
    const clock = { now: BASE_TIME };
    const databasePath = temporaryDatabase();
    const seed = await fixture(clock, { databasePath });
    const seededDriver = await onlineDriver(seed);
    await seed.close();
    // This isolated database has a pending delivery; no operational write endpoint is being invented.
    const database = new DatabaseSync(databasePath);
    try {
      const row = database.prepare('SELECT data FROM app_state WHERE id = 1').get() as { data: string };
      const state = JSON.parse(row.data) as AppState;
      const delivery: Delivery = { id: randomUUID(), code: 'GPS-TEST', customer: 'Cliente de teste',
        address: 'Endereço de teste', neighborhood: 'Teste', phone: '', driverId: seededDriver.user.driverId!,
        status: 'pending', window: '', estimatedKm: 10, position: { x: 50, y: 50 }, note: '' };
      state.deliveries.push(delivery);
      database.prepare('UPDATE app_state SET data = ? WHERE id = 1').run(JSON.stringify(state));
    } finally { database.close(); }
    const api = await fixture(clock, { databasePath });
    const driver = await api.login(seededDriver.user.email, USER_PASSWORD);
    const delivery = (await api.state(driver.token)).state.deliveries[0];
    const { trackingSession } = await start(api, driver);
    expect((await api.command(driver.token, { type: 'start', driverId: driver.user.driverId!, deliveryId: delivery.id })).status).toBe(200);
    const samples = [point(BASE_TIME), point(BASE_TIME + 10_000, LATITUDE + 0.001)];
    clock.now += 10_000;
    expect((await points(api, driver, trackingSession.id, samples)).status).toBe(200);
    const inProgress = (await api.state(driver.token)).state;
    expect(inProgress.trips[0]).toMatchObject({ progress: 0, distanceSource: 'gps' });
    expect(inProgress.trips[0].km).toBeCloseTo(0.111195, 5);
    expect(inProgress.drivers[0].kmToday).toBeCloseTo(inProgress.trips[0].km, 5);
    expect((await api.command(driver.token, { type: 'advance', deliveryId: delivery.id })).status).toBe(403);
    expect((await api.command(driver.token, { type: 'complete', deliveryId: delivery.id, receivedBy: '  Pessoa de teste  ' })).status).toBe(200);
    const completed = (await api.state(driver.token)).state;
    expect(completed.deliveries[0]).toMatchObject({ status: 'delivered', receivedBy: 'Pessoa de teste' });
    expect(completed.trips[0].finishedAt).toBe(new Date(clock.now).toISOString());
    expect(completed.trips[0].km).toBeCloseTo(0.111195, 5);
    expect(completed.drivers[0].kmToday).toBeCloseTo(0.111195, 5);
    clock.now += 10_000;
    expect((await points(api, driver, trackingSession.id, [point(clock.now, LATITUDE + 0.002)])).status).toBe(200);
    const after = (await api.state(driver.token)).state;
    expect(after.trips[0].km).toBeCloseTo(completed.trips[0].km, 5);
    expect(after.drivers[0].kmToday).toBeCloseTo(0.22239, 5);
  });
});
