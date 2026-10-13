import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedClient, normalizeApiUrl } from './connected';
import { createDemoState } from './demo';
import type { AppState, AppUser } from './types';

const native = vi.hoisted(() => ({ value: false }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.value } }));

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
