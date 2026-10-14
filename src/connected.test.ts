import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedClient, normalizeApiUrl } from './connected';
import { createDemoState } from './demo';
import type { AppState, AppUser } from './types';

const native = vi.hoisted(() => ({ value: false }));
const gps = vi.hoisted(() => ({
  getDeviceId: vi.fn(), start: vi.fn(), stop: vi.fn(), getStatus: vi.fn(), sync: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.value, getPlatform: () => native.value ? 'android' : 'web' } }));
vi.mock('./tracking/native', () => ({ RotaTracking: gps }));

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const response = (data: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const seed = () => createDemoState('2026-10-13');
const stateResponse = (state = seed(), revision = 0) => response({ state, revision, simulation: true });
const auth = (user: AppUser = seed().users[0], token = 'opaque-session-token') => response({ user, token, expiresAt: '2099-01-01T00:00:00Z' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const clients: ConnectedClient[] = [];
const makeClient = () => { const notify = vi.fn(); const client = new ConnectedClient(notify); clients.push(client); return { client, notify }; };
let local: MemoryStorage;
let session: MemoryStorage;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  native.value = false;
  local = new MemoryStorage(); session = new MemoryStorage();
  vi.stubGlobal('localStorage', local); vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('document', { visibilityState: 'visible' });
  vi.stubEnv('VITE_API_URL', '');
  fetchMock = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetchMock);
  Object.values(gps).forEach(mock => mock.mockReset());
  gps.getDeviceId.mockResolvedValue({ deviceId: 'android-device' });
  for (const method of [gps.start, gps.stop, gps.getStatus, gps.sync]) method.mockResolvedValue({ running: false, pending: 0, dropped: 0, error: '' });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
async function signIn(client: ConnectedClient, user = seed().users[0]) {
  fetchMock.mockResolvedValueOnce(auth(user)).mockResolvedValueOnce(stateResponse());
  expect(await client.login(user.email, 'private-password')).toBe(true);
}

describe('Endereço e credenciais do servidor', () => {
  it('aceita HTTPS e HTTP local, mantendo o prefixo e removendo barras finais', () => {
    expect(normalizeApiUrl(' https://example.com/rota/// ')).toBe('https://example.com/rota');
    expect(normalizeApiUrl('http://127.0.0.1:3001/')).toBe('http://127.0.0.1:3001');
    expect(normalizeApiUrl('')).toBe('');
    for (const url of ['http://example.com', 'javascript:alert(1)', 'file:///tmp/app', 'https://user:secret@example.com', 'https://example.com/?token=secret', 'https://example.com/#fragment']) expect(() => normalizeApiUrl(url)).toThrow();
  });
  it('guarda somente a URL no armazenamento persistente e o token por aba', async () => {
    const { client } = makeClient();
    fetchMock.mockResolvedValueOnce(auth()).mockResolvedValueOnce(stateResponse());
    expect(await client.login('gestor@example.com', 'private-password', 'https://example.com/rota/')).toBe(true);
    expect([...local.values.values()]).toEqual(['https://example.com/rota']);
    expect([...session.values.values()].join()).toContain('opaque-session-token');
    expect([...local.values.values()].join()).not.toContain('private-password');
    expect(fetchMock.mock.calls[1][0]).toBe('https://example.com/rota/api/state');
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer opaque-session-token' });
    expect(fetchMock.mock.calls[1][1]?.redirect).toBe('error');
  });
  it('não reaproveita uma sessão ao trocar o endereço configurado', () => {
    local.setItem('rota.connected.api-url.v1', 'https://new.example.com');
    session.setItem('rota.connected.session.v1', JSON.stringify({ apiUrl: 'https://old.example.com', token: 'old-token' }));
    const { client } = makeClient(); client.start();
    expect(client.getSnapshot().status).toBe('signed-out');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('exige servidor explícito no Android e não faz requisição para a origem nativa', async () => {
    native.value = true;
    const { client } = makeClient(); client.start();
    expect(await client.login('gestor@example.com', 'private-password')).toBe(false);
    expect(client.getSnapshot().error).toContain('HTTPS');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Concorrência e ciclo da sessão', () => {
  it('descarta login antigo que termina depois de uma nova conta entrar', async () => {
    const old = deferred<Response>();
    const { client } = makeClient();
    fetchMock.mockReturnValueOnce(old.promise);
    const first = client.login('first@example.com', 'private-password');
    const secondUser = seed().users.find(item => item.role === 'driver')!;
    fetchMock.mockResolvedValueOnce(auth(secondUser, 'second-token')).mockResolvedValueOnce(stateResponse());
    expect(await client.login(secondUser.email, 'another-password', 'https://second.example.com')).toBe(true);
    old.resolve(auth(seed().users[0], 'first-token'));
    expect(await first).toBe(false);
    expect(client.getSnapshot().user?.id).toBe(secondUser.id);
    expect(client.getSnapshot().apiUrl).toBe('https://second.example.com');
    expect([...session.values.values()].join()).not.toContain('first-token');
  });
  it('limpa dados e token antes da revogação, ignorando resposta tardia do estado', async () => {
    const { client } = makeClient(); await signIn(client);
    const pending = deferred<Response>(); const revocation = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise).mockReturnValueOnce(revocation.promise);
    const refresh = client.refresh(); const logout = client.logout();
    expect(client.getSnapshot().user).toBeNull();
    expect(client.getSnapshot().state).toBeNull();
    expect(session.values.size).toBe(0);
    pending.resolve(stateResponse(seed(), 99)); revocation.resolve(response(null, 204));
    await Promise.all([refresh, logout]);
    expect(client.getSnapshot().status).toBe('signed-out');
    expect(client.getSnapshot().state).toBeNull();
  });
  it('ignora leitura antiga quando outra sincronização conclui primeiro', async () => {
    const { client } = makeClient(); await signIn(client);
    const old = deferred<Response>();
    const newer = seed(); newer.deliveries[0].customer = 'Cliente atualizado';
    fetchMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce(stateResponse(newer, 2));
    const first = client.refresh(); await client.refresh();
    old.resolve(stateResponse(seed(), 1)); await first;
    expect(client.getSnapshot().state?.deliveries[0].customer).toBe('Cliente atualizado');
    expect(client.getSnapshot().syncing).toBe(false);
  });
  it('remove sessão expirada sem recorrer à demonstração', async () => {
    const { client } = makeClient(); await signIn(client);
    fetchMock.mockResolvedValueOnce(response({ error: 'Sessão expirada.' }, 401));
    await client.refresh();
    expect(client.getSnapshot()).toMatchObject({ user: null, state: null, status: 'signed-out', syncing: false });
    expect(session.values.size).toBe(0);
  });
});

describe('Alterações confirmadas pelo servidor', () => {
  it('enfileira alterações com a última revisão e aguarda confirmação antes de atualizar a tela', async () => {
    const { client } = makeClient(); await signIn(client);
    const first = deferred<Response>();
    const updated = seed(); updated.deliveries[0].customer = 'Primeira alteração';
    fetchMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce(stateResponse(updated, 2));
    const before = client.getSnapshot().state;
    const one = client.actions.assignDelivery('e5', 'd1');
    const two = client.actions.assignDelivery('e6', 'd2');
    await Promise.resolve();
    expect(fetchMock.mock.calls.length).toBe(3);
    expect(client.getSnapshot().state).toBe(before);
    expect(JSON.parse(fetchMock.mock.calls[2][1]?.body as string).revision).toBe(0);
    first.resolve(stateResponse(updated, 1));
    expect(await one).toBe(true); expect(await two).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[3][1]?.body as string).revision).toBe(1);
    expect(client.getSnapshot().state?.deliveries[0].customer).toBe('Primeira alteração');
    expect(client.getSnapshot().syncing).toBe(false);
  });
  it('sincroniza um conflito e pede repetição sem reenviar a alteração', async () => {
    const { client, notify } = makeClient(); await signIn(client);
    const updated = seed(); updated.deliveries[0].customer = 'Mudança de outra conta';
    fetchMock.mockResolvedValueOnce(response({ error: 'Versão antiga.' }, 409)).mockResolvedValueOnce(stateResponse(updated, 3));
    expect(await client.actions.assignDelivery('e5', 'd1')).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/commands')).length).toBe(1);
    expect(client.getSnapshot().state?.deliveries[0].customer).toBe('Mudança de outra conta');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('repita'));
    expect(client.getSnapshot().error).toBe('');
  });
  it('preserva os últimos dados quando offline e bloqueia alterações até sincronizar', async () => {
    const { client } = makeClient(); await signIn(client);
    const before = client.getSnapshot().state;
    fetchMock.mockRejectedValueOnce(new TypeError('Network unavailable'));
    await client.refresh();
    expect(client.getSnapshot().state).toBe(before);
    expect(client.getSnapshot().error).toContain('conectar');
    const calls = fetchMock.mock.calls.length;
    expect(await client.actions.assignDelivery('e5', 'd1')).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(calls);
    fetchMock.mockResolvedValueOnce(stateResponse(seed(), 1)); await client.refresh();
    expect(client.getSnapshot().error).toBe('');
    fetchMock.mockResolvedValueOnce(stateResponse(seed(), 2));
    expect(await client.actions.assignDelivery('e5', 'd1')).toBe(true);
  });
  it('retorna false em rejeição de formulário, preserva os dados e envia usuário pela rota dedicada', async () => {
    const { client, notify } = makeClient(); await signIn(client);
    const before = client.getSnapshot().state;
    fetchMock.mockResolvedValueOnce(response({ error: 'Este e-mail já está cadastrado.' }, 422));
    expect(await client.actions.saveUser(seed().users[0], 'replacement-password')).toBe(false);
    expect(client.getSnapshot().state).toBe(before);
    expect(client.getSnapshot().error).toBe('');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/users');
    expect(JSON.parse(fetchMock.mock.calls[2][1]?.body as string)).toEqual({ user: seed().users[0], password: 'replacement-password' });
    expect(notify).toHaveBeenCalledWith('Este e-mail já está cadastrado.');
  });
  it('encerra requisição travada em dez segundos e mantém a saída da conta disponível', async () => {
    vi.useFakeTimers();
    const { client } = makeClient(); await signIn(client);
    fetchMock.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = client.refresh();
    await vi.advanceTimersByTimeAsync(10_000); await pending;
    expect(client.getSnapshot().error).toContain('demorou');
    expect(client.getSnapshot().syncing).toBe(false);
    fetchMock.mockRejectedValueOnce(new TypeError('Offline'));
    await client.logout();
    expect(client.getSnapshot().state).toBeNull();
  });
});

const driverUser = () => seed().users.find(item => item.role === 'driver')!;
const realStateResponse = (state = seed(), revision = 0) => response({ state, revision, simulation: false });
const trackingSession = () => ({ id: 'gps-session', driverId: driverUser().driverId!, deviceId: 'android-device', startedAt: '2026-10-13T14:00:00Z', meters: 0, acceptedPoints: 0, rejectedPoints: 0, gaps: 0 });
const realStartResponse = (state = seed(), revision = 1) => {
  const session = trackingSession();
  return response({ state: { ...state, trackingSessions: [...(state.trackingSessions ?? []).filter(item => item.id !== session.id), session] },
    revision, simulation: false, trackingSession: session });
};
async function signInProduction(client: ConnectedClient, account = driverUser(), state = seed()) {
  native.value = true;
  fetchMock.mockResolvedValueOnce(auth(account)).mockResolvedValueOnce(realStateResponse(state));
  expect(await client.login(account.email, 'private-password', 'https://api.example.com/rota')).toBe(true);
  gps.stop.mockClear();
}

describe('GPS Android conectado', () => {
  it('não ativa captura no login e entrega credenciais somente à camada nativa', async () => {
    const { client } = makeClient(); await signInProduction(client);
    expect(gps.start).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(realStateResponse());
    await client.syncTracking();
    expect(gps.sync).toHaveBeenCalledWith({ apiUrl: 'https://api.example.com/rota', token: 'opaque-session-token', userId: driverUser().id, driverId: driverUser().driverId, expiresAt: '2099-01-01T00:00:00Z' });
    expect(JSON.stringify(client.getSnapshot())).not.toContain('opaque-session-token');
    expect([...local.values.values()].join()).not.toContain('opaque-session-token');
  });
  it('bloqueia GPS no navegador, em demonstração e para administrador', async () => {
    const web = makeClient().client; await signIn(web, driverUser());
    await expect(web.startTracking()).rejects.toThrow('Android');
    const simulated = makeClient().client;
    native.value = true;
    fetchMock.mockResolvedValueOnce(auth(driverUser())).mockResolvedValueOnce(stateResponse());
    expect(await simulated.login(driverUser().email, 'private-password', 'https://api.example.com')).toBe(true);
    await expect(simulated.startTracking()).rejects.toThrow('Android');
    const admin = makeClient().client; await signInProduction(admin, seed().users[0]);
    await expect(admin.startTracking()).rejects.toThrow('entregador');
    expect(gps.getDeviceId).not.toHaveBeenCalled();
  });
  it('exige turno ativo antes de criar sessão de GPS', async () => {
    const state = seed(); state.drivers.find(item => item.id === driverUser().driverId)!.status = 'offline';
    const { client } = makeClient(); await signInProduction(client, driverUser(), state);
    await expect(client.startTracking()).rejects.toThrow('turno');
    expect(gps.getDeviceId).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.length).toBe(2);
  });
  it('cria sessão do aparelho no servidor antes da captura e incorpora a revisão', async () => {
    const { client } = makeClient(); await signInProduction(client);
    const updated = seed(); updated.gpsDays = [{ driverId: driverUser().driverId!, date: '2026-10-13', meters: 200, acceptedPoints: 3, gaps: 0 }];
    fetchMock.mockResolvedValueOnce(realStartResponse(updated, 3));
    gps.start.mockResolvedValueOnce({ running: true, sessionId: 'gps-session', pending: 0, dropped: 0, error: '' });
    expect((await client.startTracking()).running).toBe(true);
    expect(fetchMock.mock.calls[2][0]).toBe('https://api.example.com/rota/api/tracking/start');
    expect(JSON.parse(fetchMock.mock.calls[2][1]?.body as string)).toEqual({ deviceId: 'android-device' });
    expect(gps.start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'gps-session', driverId: driverUser().driverId, deviceId: 'android-device', token: 'opaque-session-token' }));
    expect(client.getSnapshot().state?.gpsDays?.[0].meters).toBe(200);
    fetchMock.mockResolvedValueOnce(realStateResponse(updated, 4));
    expect(await client.actions.startRoute('e1', driverUser().driverId!)).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[3][1]?.body as string).revision).toBe(3);
  });
  it('encerra sessão vazia se a permissão de localização for recusada', async () => {
    const { client } = makeClient(); await signInProduction(client);
    fetchMock.mockResolvedValueOnce(realStartResponse()).mockResolvedValueOnce(realStateResponse(seed(), 2));
    gps.start.mockRejectedValueOnce(new Error('Permita o acesso à localização.'));
    await expect(client.startTracking()).rejects.toThrow('localização');
    expect(fetchMock.mock.calls[3][0]).toBe('https://api.example.com/rota/api/tracking/stop');
    expect(JSON.parse(fetchMock.mock.calls[3][1]?.body as string)).toEqual({ sessionId: 'gps-session' });
    expect(client.getSnapshot().status).toBe('ready');
    expect(client.getSnapshot().state).not.toBeNull();
  });
  it('preserva o erro de permissão retornado pelo serviço sem captura', async () => {
    const { client } = makeClient(); await signInProduction(client);
    fetchMock.mockResolvedValueOnce(realStartResponse()).mockResolvedValueOnce(realStateResponse(seed(), 2));
    gps.start.mockResolvedValueOnce({ running: false, pending: 0, dropped: 0, error: 'Ative a localização precisa.' });
    expect((await client.startTracking()).error).toBe('Ative a localização precisa.');
    expect(gps.stop).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[3][0]).toContain('/api/tracking/stop');
  });
  it('deixa a fila nativa confirmar os pontos antes de encerrar a sessão', async () => {
    const { client } = makeClient(); await signInProduction(client);
    const pending = deferred<ReturnType<typeof gps.stop>>();
    gps.stop.mockReturnValueOnce(pending.promise);
    fetchMock.mockResolvedValueOnce(realStateResponse(seed(), 1));
    const stopping = client.stopTracking();
    expect(fetchMock.mock.calls.length).toBe(2);
    pending.resolve({ running: false, pending: 12, dropped: 0, error: 'Sem conexão.' });
    expect((await stopping).pending).toBe(12);
    expect(fetchMock.mock.calls.map(([url]) => String(url)).some(url => url.endsWith('/api/tracking/stop'))).toBe(false);
    expect(client.getSnapshot().syncing).toBe(false);
  });
  it('limpa a tela na saída e aguarda a última tentativa nativa antes de revogar o token', async () => {
    const { client } = makeClient(); await signInProduction(client);
    const pending = deferred<unknown>(); gps.stop.mockReturnValueOnce(pending.promise);
    fetchMock.mockResolvedValueOnce(response(null, 204));
    const logout = client.logout();
    expect(client.getSnapshot().user).toBeNull();
    expect(session.values.size).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(2);
    pending.resolve({ running: false, pending: 4, dropped: 0, error: 'Sem conexão.' });
    await logout;
    expect(fetchMock.mock.calls[2][0]).toContain('/api/auth/logout');
  });
  it('mantém saída disponível se o plugin nativo não resolver em dez segundos', async () => {
    vi.useFakeTimers();
    const { client } = makeClient(); await signInProduction(client);
    gps.stop.mockReturnValueOnce(new Promise(() => {}));
    fetchMock.mockResolvedValueOnce(response(null, 204));
    const logout = client.logout();
    await vi.advanceTimersByTimeAsync(10_000); await logout;
    expect(client.getSnapshot().status).toBe('signed-out');
    expect(fetchMock.mock.calls[2][0]).toContain('/api/auth/logout');
  });
  it('para captura quando a conta é desativada ou muda de função', async () => {
    const { client } = makeClient(); await signInProduction(client);
    const changed = seed(); changed.users.find(item => item.id === driverUser().id)!.role = 'manager';
    fetchMock.mockResolvedValueOnce(realStateResponse(changed, 1)); await client.refresh();
    expect(gps.stop).toHaveBeenCalledOnce();
    expect(client.getSnapshot().user?.role).toBe('manager');
    const inactive = seed(); inactive.users.find(item => item.id === driverUser().id)!.active = false;
    fetchMock.mockResolvedValueOnce(realStateResponse(inactive, 2)); await client.refresh();
    expect(gps.stop).toHaveBeenCalledTimes(2);
    expect(client.getSnapshot().status).toBe('signed-out');
  });
  it('para captura no vencimento local da sessão sem depender da rede', async () => {
    vi.useFakeTimers();
    const { client } = makeClient(); native.value = true;
    fetchMock.mockResolvedValueOnce(response({ user: driverUser(), token: 'short-token', expiresAt: new Date(Date.now() + 1_000).toISOString() })).mockResolvedValueOnce(realStateResponse());
    expect(await client.login(driverUser().email, 'private-password', 'https://api.example.com')).toBe(true);
    gps.stop.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gps.stop).toHaveBeenCalledOnce();
    expect(client.getSnapshot().status).toBe('signed-out');
    expect(session.values.size).toBe(0);
  });
  it('descarta criação tardia de GPS quando a conta mudou', async () => {
    const { client } = makeClient(); await signInProduction(client);
    const pending = deferred<Response>(); fetchMock.mockReturnValueOnce(pending.promise);
    const starting = client.startTracking(); await Promise.resolve();
    fetchMock.mockResolvedValueOnce(response(null, 204)); await client.logout();
    pending.resolve(realStartResponse(seed(), 99));
    await expect(starting).rejects.toThrow('sessão mudou');
    expect(gps.start).not.toHaveBeenCalled();
    expect(client.getSnapshot().state).toBeNull();
  });
  it('não ativa GPS com resposta atrasada após conhecer o encerramento do turno', async () => {
    const { client } = makeClient(); await signInProduction(client);
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    gps.start.mockResolvedValueOnce({ running: true, sessionId: 'gps-session', pending: 0, dropped: 0, error: '' });
    const starting = client.startTracking();
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/tracking/start'))).toBe(true));

    const stopped = seed();
    const driver = stopped.drivers.find(item => item.id === driverUser().driverId)!;
    driver.status = 'offline'; driver.shiftStartedAt = null;
    stopped.trackingSessions = [{ ...trackingSession(), endedAt: '2026-10-13T14:01:00Z' }];
    fetchMock.mockResolvedValueOnce(realStateResponse(stopped, 2));
    await client.refresh();
    fetchMock.mockResolvedValueOnce(realStateResponse(stopped, 3));
    pending.resolve(realStartResponse(seed(), 1));

    await expect(starting).rejects.toThrow(/turno|encerrad/i);
    expect(gps.start).not.toHaveBeenCalled();
  });
  it.each([false, true])('fecha a sessão durante o diálogo e ignora ativação tardia running=%s após sair', async running => {
    const { client } = makeClient(); await signInProduction(client);
    const permission = deferred<unknown>();
    gps.start.mockReturnValueOnce(permission.promise);
    fetchMock.mockResolvedValueOnce(realStartResponse());
    const starting = client.startTracking();
    await vi.waitFor(() => expect(gps.start).toHaveBeenCalledOnce());
    fetchMock.mockResolvedValueOnce(realStateResponse(seed(), 99)).mockResolvedValueOnce(response(null, 204));
    await client.logout();
    expect(fetchMock.mock.calls.slice(3).map(([url]) => String(url))).toEqual([
      'https://api.example.com/rota/api/tracking/stop', 'https://api.example.com/rota/api/auth/logout',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[3][1]?.body as string)).toEqual({ sessionId: 'gps-session' });
    expect(client.getSnapshot().state).toBeNull();
    permission.resolve({ running, pending: 0, dropped: 0, error: '' });
    await expect(starting).rejects.toThrow('sessão mudou');
    expect(client.getSnapshot()).toMatchObject({ user: null, state: null, status: 'signed-out' });
    expect(session.values.size).toBe(0);
    expect(gps.start).toHaveBeenCalledOnce();
    await expect(client.getTrackingStatus()).rejects.toThrow('Android');
    expect(gps.getStatus).not.toHaveBeenCalled();
  });
  it('não fecha a sessão antes de confirmar pontos capturados durante uma ativação pendente', async () => {
    const { client } = makeClient(); await signInProduction(client);
    const permission = deferred<unknown>();
    gps.start.mockReturnValueOnce(permission.promise);
    fetchMock.mockResolvedValueOnce(realStartResponse());
    const starting = client.startTracking();
    await vi.waitFor(() => expect(gps.start).toHaveBeenCalledOnce());
    gps.stop.mockResolvedValueOnce({ running: false, pending: 5, dropped: 0, error: 'Sem conexão.' });
    fetchMock.mockResolvedValueOnce(response(null, 204));
    await client.logout();
    expect(fetchMock.mock.calls.map(([url]) => String(url)).some(url => url.endsWith('/api/tracking/stop'))).toBe(false);
    permission.resolve({ running: false, pending: 5, dropped: 0, error: '' });
    await expect(starting).rejects.toThrow('sessão mudou');
  });
  it('não deixa uma permissão tardia misturar dados nem credenciais de uma nova conta', async () => {
    const { client } = makeClient(); await signInProduction(client);
    const permission = deferred<unknown>();
    gps.start.mockReturnValueOnce(permission.promise);
    fetchMock.mockResolvedValueOnce(realStartResponse());
    const starting = client.startTracking();
    await vi.waitFor(() => expect(gps.start).toHaveBeenCalledOnce());
    fetchMock.mockResolvedValueOnce(realStateResponse(seed(), 2)).mockResolvedValueOnce(response(null, 204));
    await client.logout();
    const nextUser = seed().users.find(item => item.role === 'driver' && item.id !== driverUser().id)!;
    fetchMock.mockResolvedValueOnce(auth(nextUser, 'new-account-token')).mockResolvedValueOnce(realStateResponse());
    expect(await client.login(nextUser.email, 'private-password', 'https://api.example.com/rota')).toBe(true);
    permission.resolve({ running: true, pending: 0, dropped: 0, error: '' });
    await expect(starting).rejects.toThrow('sessão mudou');
    expect(client.getSnapshot().user?.id).toBe(nextUser.id);
    fetchMock.mockResolvedValueOnce(realStateResponse()); await client.syncTracking();
    expect(gps.sync).toHaveBeenLastCalledWith(expect.objectContaining({ token: 'new-account-token', userId: nextUser.id, driverId: nextUser.driverId }));
    expect([...session.values.values()].join()).not.toContain('opaque-session-token');
  });
  it('sincroniza uma sessão com fechamento pendente antes de permitir outra captura', async () => {
    const { client } = makeClient(); await signInProduction(client);
    fetchMock.mockResolvedValueOnce(realStartResponse()).mockResolvedValueOnce(realStateResponse(seed(), 2));
    gps.start.mockRejectedValueOnce(Object.assign(new Error('Pontos pendentes.'), { code: 'GPS_PENDING' }));
    gps.sync.mockResolvedValueOnce({ running: false, pending: 3, dropped: 0, error: 'Sem conexão.' });
    await expect(client.startTracking()).rejects.toThrow('Envie os pontos pendentes');
    expect(gps.sync).toHaveBeenCalledOnce();
    expect(gps.stop).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url]) => String(url)).some(url => url.endsWith('/api/tracking/stop'))).toBe(false);
    expect(client.getSnapshot().status).toBe('ready');
  });
  it('não bloqueia alterações enquanto consulta apenas o estado do GPS', async () => {
    const { client } = makeClient(); await signInProduction(client);
    const pending = deferred<unknown>(); gps.getStatus.mockReturnValueOnce(pending.promise);
    const reading = client.getTrackingStatus();
    expect(client.getSnapshot().syncing).toBe(false);
    pending.resolve({ running: true, pending: 5, dropped: 0, error: '' }); await reading;
    const remote = deferred<Response>(); fetchMock.mockReturnValueOnce(remote.promise);
    gps.getStatus.mockResolvedValueOnce({ running: true, pending: 0, dropped: 0, error: '' });
    await client.getTrackingStatus();
    expect(client.getSnapshot().syncing).toBe(false);
    remote.resolve(realStateResponse(seed(), 1)); await Promise.resolve();
  });
  it('valida coordenadas e totais de GPS antes de substituir os dados', async () => {
    const { client } = makeClient(); await signInProduction(client);
    const valid = seed(); valid.drivers[0].gps = { id: 'gps-point', latitude: -23.55, longitude: -46.63, accuracy: 8, recordedAt: '2026-10-13T15:00:00Z', receivedAt: '2026-10-13T15:00:01Z' };
    valid.trackingSessions = [trackingSession()];
    valid.gpsDays = [{ driverId: valid.drivers[0].id, date: '2026-10-13', meters: 120, acceptedPoints: 3, gaps: 0 }];
    fetchMock.mockResolvedValueOnce(realStateResponse(valid, 1)); await client.refresh();
    expect(client.getSnapshot().state?.drivers[0].gps?.latitude).toBe(-23.55);
    const invalid: AppState = structuredClone(valid); invalid.drivers[0].gps!.latitude = 120;
    fetchMock.mockResolvedValueOnce(realStateResponse(invalid, 2)); await client.refresh();
    expect(client.getSnapshot().state?.drivers[0].gps?.latitude).toBe(-23.55);
    expect(client.getSnapshot().error).toContain('incompatíveis');
  });
});
