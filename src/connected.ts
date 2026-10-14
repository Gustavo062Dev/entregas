import { Capacitor } from '@capacitor/core';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Command } from './domain';
import type { AppActions, AppState, AppUser, TrackingStatus } from './types';
import { RotaTracking } from './tracking/native';
import { useTracking } from './tracking/useTracking';

const API_URL_KEY = 'rota.connected.api-url.v1';
const SESSION_KEY = 'rota.connected.session.v1';
const REQUEST_TIMEOUT = 10_000;
const POLL_INTERVAL = 5_000;

type Status = 'loading' | 'signed-out' | 'ready' | 'unavailable';
export interface ConnectedSnapshot {
  user: AppUser | null;
  state: AppState | null;
  status: Status;
  syncing: boolean;
  error: string;
  apiUrl: string;
  simulation: boolean;
}
interface StateResponse { state: AppState; revision: number; simulation: boolean; message?: string }
interface AuthResponse { token: string; user: AppUser; expiresAt: string }
interface SessionResponse { user: AppUser; expiresAt: string }
interface PendingTrackingStart { epoch: number; sessionId: string; apiUrl: string; token: string }

class ApiError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

/** An empty URL uses the web page's origin. Android requires an explicit URL. */
export function normalizeApiUrl(input: string): string {
  const value = input.trim();
  if (!value) return '';
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Informe o endereço completo do servidor, começando com https://.'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('O endereço do servidor não pode conter credenciais, parâmetros ou fragmentos.');
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Use HTTPS para conectar ao servidor. HTTP é permitido apenas no computador local de desenvolvimento.');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function initialApiUrl() {
  try {
    const saved = localStorage.getItem(API_URL_KEY);
    if (saved !== null) return normalizeApiUrl(saved);
  } catch { /* Storage can be unavailable in private browsing. */ }
  try { return normalizeApiUrl(import.meta.env.VITE_API_URL ?? ''); }
  catch { return ''; }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function strings(value: Record<string, unknown>, keys: string[]) { return keys.every(key => typeof value[key] === 'string'); }
function date(value: unknown) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function position(value: unknown) { return record(value) && ['x', 'y'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key])); }
function finite(value: unknown) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function count(value: unknown) { return Number.isSafeInteger(value) && finite(value); }
function gpsPoint(value: unknown) {
  return record(value) && strings(value, ['id']) && date(value.recordedAt)
    && typeof value.latitude === 'number' && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90
    && typeof value.longitude === 'number' && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180
    && finite(value.accuracy);
}
function trackingSession(value: unknown) {
  return record(value) && strings(value, ['id', 'driverId', 'deviceId']) && date(value.startedAt)
    && (value.endedAt === undefined || date(value.endedAt)) && finite(value.meters)
    && ['acceptedPoints', 'rejectedPoints', 'gaps'].every(key => count(value[key]))
    && (value.lastPoint === undefined || gpsPoint(value.lastPoint)) && (value.anchor === undefined || gpsPoint(value.anchor));
}
function user(value: unknown): value is AppUser {
  return record(value) && strings(value, ['id', 'name', 'email']) && ['admin', 'manager', 'driver'].includes(String(value.role)) && typeof value.active === 'boolean' && (value.driverId === undefined || typeof value.driverId === 'string');
}
function appState(value: unknown): value is AppState {
  return record(value) && value.version === 1 && typeof value.demoDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.demoDate)
    && Array.isArray(value.users) && value.users.every(user)
    && Array.isArray(value.drivers) && value.drivers.every(item => record(item) && strings(item, ['id', 'name', 'initials', 'color', 'phone', 'vehicle']) && ['available', 'on_route', 'offline'].includes(String(item.status)) && position(item.position) && finite(item.kmToday) && (item.shiftStartedAt === null || date(item.shiftStartedAt)) && (item.gps === undefined || (gpsPoint(item.gps) && record(item.gps) && date(item.gps.receivedAt))))
    && Array.isArray(value.deliveries) && value.deliveries.every(item => record(item) && strings(item, ['id', 'code', 'customer', 'address', 'neighborhood', 'phone', 'window', 'note']) && ['pending', 'in_transit', 'delivered'].includes(String(item.status)) && position(item.position) && finite(item.estimatedKm) && (item.driverId === null || typeof item.driverId === 'string') && (item.deliveredAt === undefined || date(item.deliveredAt)) && (item.receivedBy === undefined || typeof item.receivedBy === 'string'))
    && Array.isArray(value.trips) && value.trips.every(item => record(item) && strings(item, ['id', 'driverId', 'deliveryId', 'date']) && date(item.startedAt) && (item.finishedAt === undefined || date(item.finishedAt)) && finite(item.km) && finite(item.progress) && (item.progress as number) <= 1 && (item.distanceSource === undefined || ['gps', 'simulation'].includes(String(item.distanceSource))) && (item.distanceMeters === undefined || finite(item.distanceMeters)))
    && (value.trackingSessions === undefined || (Array.isArray(value.trackingSessions) && value.trackingSessions.every(trackingSession)))
    && (value.gpsDays === undefined || (Array.isArray(value.gpsDays) && value.gpsDays.every(item => record(item) && strings(item, ['driverId', 'date']) && /^\d{4}-\d{2}-\d{2}$/.test(String(item.date)) && finite(item.meters) && count(item.acceptedPoints) && count(item.gaps))));
}
function stateResponse(value: unknown): StateResponse {
  if (!record(value) || !appState(value.state) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || typeof value.simulation !== 'boolean' || (value.message !== undefined && typeof value.message !== 'string')) throw new ApiError('O servidor retornou dados incompatíveis. Tente sincronizar novamente.');
  return value as unknown as StateResponse;
}
function sessionResponse(value: unknown): SessionResponse {
  if (!record(value) || !user(value.user) || !date(value.expiresAt)) throw new ApiError('O servidor retornou uma sessão inválida. Entre novamente.');
  if (!value.user.active || Date.parse(value.expiresAt as string) <= Date.now()) throw new ApiError('Sua sessão expirou. Entre novamente.', 401);
  return value as unknown as SessionResponse;
}

/** Session-bound transport; keeping it separate from React makes request races testable. */
export class ConnectedClient {
  private snapshot: ConnectedSnapshot;
  private token: string | null = null;
  private expiresAt: string | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private nativeStatus: TrackingStatus | null = null;
  private pendingTrackingStart: PendingTrackingStart | null = null;
  private nativeShutdown: Promise<void> | null = null;
  private revision = -1;
  private epoch = 0;
  private readSequence = 0;
  private reads = 0;
  private mutations = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private controllers = new Set<AbortController>();
  private listeners = new Set<() => void>();
  private poll: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private notifier: (message: string) => void;
  readonly actions: AppActions;

  constructor(notify: (message: string) => void) {
    this.notifier = notify;
    const apiUrl = initialApiUrl();
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null');
      if (record(saved) && saved.apiUrl === apiUrl && typeof saved.token === 'string' && saved.token.length > 0 && saved.token.length <= 8192) this.token = saved.token;
    } catch { /* An unavailable or corrupt session storage starts signed out. */ }
    this.snapshot = { user: null, state: null, status: this.token ? 'loading' : 'signed-out', syncing: false, error: '', apiUrl, simulation: false };
    this.actions = {
      assignDelivery: (deliveryId, driverId) => this.command({ type: 'assign', deliveryId, driverId }),
      startRoute: (deliveryId, driverId) => this.command({ type: 'start', deliveryId, driverId }),
      advanceRoute: deliveryId => this.command({ type: 'advance', deliveryId }),
      completeDelivery: (deliveryId, receivedBy) => this.command({ type: 'complete', deliveryId, receivedBy }),
      setDriverAvailability: (driverId, online) => this.command({ type: 'availability', driverId, online }),
      saveUser: (newUser, password) => this.mutate('/api/users', { user: newUser, ...(password ? { password } : {}) }),
      toggleUser: id => this.command({ type: 'toggle-user', id }),
      resetDemo: () => { this.notifier('A restauração da demonstração não está disponível no sistema conectado.'); return false; },
      notify: message => this.notifier(message),
    };
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setNotifier(notify: (message: string) => void) { this.notifier = notify; }
  private update(patch: Partial<ConnectedSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  private updateSyncing() { this.update({ syncing: this.reads + this.mutations > 0 }); }
  private invalidate() {
    this.epoch += 1;
    this.readSequence += 1;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.reads = 0;
    this.mutations = 0;
    this.queue = Promise.resolve();
  }
  private clearSession(message = '', stopNative = true) {
    // Native stop starts before credentials disappear. Its own queue keeps unsent points.
    if (stopNative) void this.stopNativeSession();
    this.pendingTrackingStart = null;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.invalidate();
    this.token = null;
    this.expiresAt = null;
    this.nativeStatus = null;
    this.revision = -1;
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* In-memory credentials have already been removed. */ }
    this.update({ user: null, state: null, status: 'signed-out', syncing: false, error: message, simulation: false });
  }
  private saveSession() {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: this.token, apiUrl: this.snapshot.apiUrl })); }
    catch { this.notifier('O navegador não pôde guardar a sessão. Você precisará entrar novamente ao recarregar.'); }
  }
  private setExpiry(expiresAt: string) {
    this.expiresAt = expiresAt;
    clearTimeout(this.expiryTimer);
    const epoch = this.epoch;
    this.expiryTimer = setTimeout(() => {
      if (epoch !== this.epoch) return;
      if (Date.parse(expiresAt) > Date.now()) this.setExpiry(expiresAt);
      else this.clearSession('Sua sessão expirou. Entre novamente.');
    }, Math.min(2_147_483_647, Math.max(0, Date.parse(expiresAt) - Date.now())));
  }
  trackingAvailable = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  private canTrack() {
    return this.trackingAvailable() && !!this.token && !!this.expiresAt && Date.parse(this.expiresAt) > Date.now()
      && this.snapshot.status === 'ready' && !this.snapshot.simulation && this.snapshot.user?.role === 'driver'
      && this.snapshot.user.active && !!this.snapshot.user.driverId && !!this.snapshot.apiUrl;
  }
  private trackingCredentials() {
    if (!this.canTrack() || !this.token || !this.expiresAt || !this.snapshot.user) throw new Error('O GPS real exige uma conta de entregador no aplicativo Android conectado.');
    return { apiUrl: this.snapshot.apiUrl, token: this.token, userId: this.snapshot.user.id, driverId: this.snapshot.user.driverId!, expiresAt: this.expiresAt };
  }
  private async stopNative(): Promise<TrackingStatus | null> {
    if (!this.trackingAvailable()) return null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        RotaTracking.stop(),
        new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), REQUEST_TIMEOUT); }),
      ]);
    } catch { return null; /* Sign-out and expiry remain possible with GPS or connectivity failures. */ }
    finally { clearTimeout(timeout); }
  }
  private async closePendingStart(pending: PendingTrackingStart | null, status: TrackingStatus | null, timeout = REQUEST_TIMEOUT) {
    // A pending permission dialog has no points. A captured/offline queue must finish natively.
    if (!pending || !status || status.running || status.pending > 0 || timeout <= 0) return;
    try { await this.request<unknown>('/api/tracking/stop', 'POST', pending.apiUrl, pending.token, { sessionId: pending.sessionId }, timeout); }
    catch { /* Reauthentication can recover the native queue and server session when offline. */ }
  }
  private stopNativeSession(): Promise<void> {
    const pending = this.pendingTrackingStart;
    this.pendingTrackingStart = null;
    const deadline = Date.now() + REQUEST_TIMEOUT;
    const stopping = this.stopNative();
    const previous = this.nativeShutdown;
    const operation = stopping.then(status => this.closePendingStart(pending, status, Math.max(0, deadline - Date.now())));
    const shutdown = previous ? Promise.all([previous, operation]).then(() => undefined) : operation;
    this.nativeShutdown = shutdown;
    void shutdown.finally(() => { if (this.nativeShutdown === shutdown) this.nativeShutdown = null; });
    return shutdown;
  }
  private adoptState(result: StateResponse, currentUser = this.snapshot.user) {
    const nextUser = result.state.users.find(item => item.id === currentUser?.id);
    if (!nextUser || !nextUser.active) {
      this.clearSession('Sua conta foi desativada ou removida. Entre novamente.');
      return false;
    }
    const priorDriver = this.snapshot.state?.drivers.find(item => item.id === currentUser?.driverId);
    const nextDriver = result.state.drivers.find(item => item.id === nextUser.driverId);
    if (currentUser?.role === 'driver' && (nextUser.role !== 'driver' || nextUser.driverId !== currentUser.driverId || result.simulation || (priorDriver?.status !== 'offline' && nextDriver?.status === 'offline'))) void this.stopNativeSession();
    this.revision = result.revision;
    this.update({ state: result.state, user: nextUser, simulation: result.simulation, status: 'ready', error: '' });
    return true;
  }
  private async request<T>(path: string, method: 'GET' | 'POST', apiUrl: string, token: string | null, body?: unknown, timeoutMs = REQUEST_TIMEOUT): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetch(`${apiUrl}${path}`, {
        method, signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      let value: unknown = null;
      if (response.status !== 204) {
        try { value = await response.json(); }
        catch { throw new ApiError('O servidor não retornou uma resposta válida. Verifique o endereço e tente sincronizar novamente.', response.status >= 400 ? response.status : 0); }
      }
      if (!response.ok) {
        const message = record(value) && typeof value.error === 'string' ? value.error.slice(0, 300) : 'Não foi possível concluir a solicitação.';
        throw new ApiError(message, response.status);
      }
      return value as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(timedOut ? 'O servidor demorou a responder. Tente sincronizar novamente.' : 'Não foi possível conectar ao servidor. Verifique a conexão e tente sincronizar.');
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  start = () => {
    if (this.started) return;
    this.started = true;
    if (this.expiresAt) this.setExpiry(this.expiresAt);
    if (Capacitor.isNativePlatform() && !this.snapshot.apiUrl) {
      this.clearSession('Informe o endereço HTTPS do servidor para conectar o aplicativo.');
    } else if (this.token) void this.refresh();
    this.poll = setInterval(() => {
      if (this.token && this.mutations === 0 && this.reads === 0 && !this.snapshot.error && document.visibilityState !== 'hidden') void this.refresh();
    }, POLL_INTERVAL);
  };
  stop = () => {
    this.started = false;
    clearInterval(this.poll);
    this.poll = undefined;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.invalidate();
    this.updateSyncing();
  };

  login = async (email: string, password: string, requestedUrl = this.snapshot.apiUrl): Promise<boolean> => {
    let apiUrl: string;
    try {
      apiUrl = normalizeApiUrl(requestedUrl);
      if (Capacitor.isNativePlatform() && !apiUrl) throw new Error('Informe o endereço HTTPS do servidor para conectar o aplicativo.');
    } catch (error) { this.update({ error: error instanceof Error ? error.message : 'Revise o endereço do servidor.' }); return false; }
    this.clearSession();
    this.update({ apiUrl, status: 'loading', syncing: true });
    try { localStorage.setItem(API_URL_KEY, apiUrl); } catch { /* URL configuration remains available for this tab. */ }
    const epoch = this.epoch;
    try {
      const raw = await this.request<unknown>('/api/auth/login', 'POST', apiUrl, null, { email: email.trim(), password });
      if (epoch !== this.epoch) return false;
      const session = sessionResponse(raw);
      if (!record(raw) || typeof raw.token !== 'string' || !raw.token || raw.token.length > 8192) throw new ApiError('O servidor retornou uma sessão inválida. Entre novamente.');
      this.token = (raw as unknown as AuthResponse).token;
      this.setExpiry(session.expiresAt);
      this.saveSession();
      this.update({ user: session.user });
      await this.refresh();
      return epoch === this.epoch && this.snapshot.status === 'ready' && !this.snapshot.error;
    } catch (error) {
      if (epoch !== this.epoch) return false;
      this.clearSession(error instanceof Error ? error.message : 'Não foi possível entrar. Tente novamente.');
      return false;
    }
  };

  logout = async () => {
    const token = this.token;
    const apiUrl = this.snapshot.apiUrl;
    const stopping = this.trackingAvailable() ? this.stopNativeSession() : null;
    this.clearSession('', false);
    // The service uploads its last batch using its RAM credentials before revocation.
    if (stopping) await stopping;
    if (token) {
      try { await this.request<null>('/api/auth/logout', 'POST', apiUrl, token); }
      catch { /* Sign-out is immediate locally even when revocation cannot reach the server. */ }
    }
  };

  refresh = (): Promise<void> => this.readState(false);
  private async readState(silent: boolean): Promise<void> {
    const token = this.token;
    if (!token) return;
    const epoch = this.epoch;
    const sequence = ++this.readSequence;
    const apiUrl = this.snapshot.apiUrl;
    if (!silent) { this.reads += 1; this.updateSyncing(); }
    try {
      let currentUser = this.snapshot.user;
      if (!currentUser) {
        const rawSession = await this.request<unknown>('/api/auth/me', 'GET', apiUrl, token);
        if (epoch !== this.epoch || sequence !== this.readSequence) return;
        const session = sessionResponse(rawSession);
        currentUser = session.user;
        this.setExpiry(session.expiresAt);
      }
      const raw = await this.request<unknown>('/api/state', 'GET', apiUrl, token);
      if (epoch !== this.epoch || sequence !== this.readSequence) return;
      const result = stateResponse(raw);
      if (result.revision < this.revision) return;
      this.adoptState(result, currentUser);
    } catch (error) {
      if (epoch !== this.epoch || sequence !== this.readSequence) return;
      const message = error instanceof Error ? error.message : 'Não foi possível sincronizar os dados.';
      if (error instanceof ApiError && error.status === 401) this.clearSession('Sua sessão expirou ou foi encerrada. Entre novamente.');
      else if (!silent) this.update({ status: this.snapshot.state && this.snapshot.user ? 'ready' : 'unavailable', error: message });
    } finally {
      if (!silent && epoch === this.epoch) { this.reads -= 1; this.updateSyncing(); }
    }
  }

  startTracking = async (): Promise<TrackingStatus> => {
    const waitingEpoch = this.epoch;
    if (this.nativeShutdown) await this.nativeShutdown;
    if (waitingEpoch !== this.epoch) throw new Error('A sessão mudou. Entre novamente antes de ativar o GPS.');
    const credentials = this.trackingCredentials();
    const currentUser = this.snapshot.user!;
    const driver = this.snapshot.state?.drivers.find(item => item.id === currentUser.driverId);
    if (!driver || driver.status === 'offline') throw new Error('Inicie seu turno antes de ativar o GPS.');
    if (this.snapshot.error) throw new Error('Sincronize os dados antes de ativar o GPS.');
    if (this.pendingTrackingStart) throw new Error('A ativação do GPS já está em andamento.');
    const epoch = this.epoch;
    const { deviceId } = await RotaTracking.getDeviceId();
    if (epoch !== this.epoch) throw new Error('A sessão mudou. Entre novamente antes de ativar o GPS.');
    if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 200) throw new Error('Não foi possível identificar este aparelho.');
    const raw = await this.request<unknown>('/api/tracking/start', 'POST', credentials.apiUrl, credentials.token, { deviceId });
    if (epoch !== this.epoch) throw new Error('A sessão mudou. Entre novamente antes de ativar o GPS.');
    const result = stateResponse(raw);
    if (!record(raw) || !trackingSession(raw.trackingSession) || !record(raw.trackingSession) || raw.trackingSession.driverId !== currentUser.driverId || raw.trackingSession.deviceId !== deviceId || raw.trackingSession.endedAt !== undefined || result.simulation) throw new ApiError('O servidor retornou uma sessão de GPS inválida.');
    const sessionId = raw.trackingSession.id as string;
    const pending: PendingTrackingStart = { epoch, sessionId, apiUrl: credentials.apiUrl, token: credentials.token };
    this.pendingTrackingStart = pending;
    if (result.revision >= this.revision) { this.readSequence += 1; this.adoptState(result); }
    const latestDriver = this.snapshot.state?.drivers.find(item => item.id === currentUser.driverId);
    const latestSession = this.snapshot.state?.trackingSessions?.find(item => item.id === sessionId);
    if (epoch !== this.epoch || !this.canTrack() || !latestDriver || latestDriver.status === 'offline'
      || !latestDriver.shiftStartedAt || !latestSession || latestSession.endedAt !== undefined) {
      if (this.pendingTrackingStart === pending) void this.stopNativeSession();
      throw new Error('Seu turno ou a sessão de GPS foi encerrado. Atualize os dados antes de ativar o GPS.');
    }
    const closeUnusedSession = async () => {
      if (epoch !== this.epoch) return;
      const stopped = stateResponse(await this.request<unknown>('/api/tracking/stop', 'POST', credentials.apiUrl, credentials.token, { sessionId }));
      if (epoch === this.epoch && stopped.revision >= this.revision) { this.readSequence += 1; this.adoptState(stopped); }
    };
    try {
      const status = await RotaTracking.start({ ...credentials, driverId: currentUser.driverId!, sessionId, deviceId });
      if (epoch !== this.epoch) throw new Error('A sessão mudou durante a ativação do GPS.');
      if (!status.running) {
        const stopped = await RotaTracking.stop();
        if (epoch !== this.epoch) throw new Error('A sessão mudou durante a ativação do GPS.');
        if (stopped.pending === 0) {
          try { await closeUnusedSession(); } catch { /* A subsequent sync can close an unused session. */ }
        }
        this.nativeStatus = { ...stopped, error: status.error || 'Autorize a localização para ativar o GPS.' };
        return this.nativeStatus;
      }
      this.nativeStatus = status;
      return status;
    } catch (error) {
      if (record(error) && error.code === 'GPS_PENDING') {
        if (this.pendingTrackingStart === pending) this.pendingTrackingStart = null;
        if (epoch === this.epoch) {
          try { await this.syncTracking(); } catch { /* The same owner's points remain saved offline. */ }
        }
        throw new Error('Envie os pontos pendentes antes de iniciar outro registro. Toque em sincronizar e tente novamente.');
      }
      // No point was captured when native permission/start failed. Close this unused session.
      if (epoch === this.epoch) {
        try { await closeUnusedSession(); }
        catch { /* The UI keeps the actual permission error and can retry server sync. */ }
      }
      throw new Error(error instanceof Error ? error.message : 'Autorize a localização para ativar o GPS.');
    } finally {
      if (this.pendingTrackingStart === pending) this.pendingTrackingStart = null;
    }
  };

  stopTracking = async (): Promise<TrackingStatus> => {
    this.trackingCredentials();
    const epoch = this.epoch;
    // Native closes the server session only after every queued point has been acknowledged.
    const status = await RotaTracking.stop();
    if (epoch !== this.epoch) throw new Error('A sessão mudou.');
    this.nativeStatus = status;
    await this.readState(true);
    return status;
  };

  syncTracking = async (): Promise<TrackingStatus> => {
    const waitingEpoch = this.epoch;
    if (this.nativeShutdown) await this.nativeShutdown;
    if (waitingEpoch !== this.epoch) throw new Error('A sessão mudou.');
    const credentials = this.trackingCredentials();
    const epoch = this.epoch;
    const status = await RotaTracking.sync(credentials);
    if (epoch !== this.epoch) throw new Error('A sessão mudou.');
    this.nativeStatus = status;
    await this.readState(true);
    return status;
  };

  getTrackingStatus = async (): Promise<TrackingStatus> => {
    this.trackingCredentials();
    const epoch = this.epoch;
    const status = await RotaTracking.getStatus();
    if (epoch !== this.epoch) throw new Error('A sessão mudou.');
    const previous = this.nativeStatus;
    this.nativeStatus = status;
    if (previous && (status.pending < previous.pending || (status.lastPoint?.id !== previous.lastPoint?.id && status.pending === 0))) void this.readState(true);
    return status;
  };

  private command(command: Command) { return this.mutate('/api/commands', { command }); }
  private mutate(path: string, payload: Record<string, unknown>): Promise<boolean> {
    if (!this.token || !this.snapshot.state || this.snapshot.error) {
      this.notifier(this.snapshot.error || 'Entre no sistema e sincronize os dados antes de fazer alterações.');
      return Promise.resolve(false);
    }
    const epoch = this.epoch;
    this.mutations += 1;
    this.updateSyncing();
    const execute = async () => {
      if (epoch !== this.epoch) return false;
      if (!this.token || this.snapshot.error) return false;
      // A completed mutation supersedes reads that started before it.
      this.readSequence += 1;
      try {
        const body = path === '/api/commands' ? { ...payload, revision: this.revision } : payload;
        const raw = await this.request<unknown>(path, 'POST', this.snapshot.apiUrl, this.token, body);
        if (epoch !== this.epoch) return false;
        const result = stateResponse(raw);
        if (result.revision < this.revision) throw new ApiError('O servidor retornou uma versão antiga dos dados. Sincronize antes de continuar.');
        this.readSequence += 1;
        if (!this.adoptState(result)) return false;
        if (result.message) this.notifier(result.message);
        return true;
      } catch (error) {
        if (epoch !== this.epoch) return false;
        if (error instanceof ApiError && error.status === 401) {
          this.clearSession('Sua sessão expirou ou foi encerrada. Entre novamente.');
        } else if (error instanceof ApiError && error.status === 409) {
          await this.refresh();
          if (epoch === this.epoch) this.notifier('Os dados mudaram desde a última sincronização. Revise as informações e repita a alteração.');
        } else {
          const message = error instanceof Error ? error.message : 'Não foi possível salvar a alteração.';
          if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500) this.update({ error: message });
          this.notifier(message);
        }
        return false;
      } finally {
        if (epoch === this.epoch) { this.mutations -= 1; this.updateSyncing(); }
      }
    };
    const operation = this.queue.then(execute);
    this.queue = operation.catch(() => false);
    return operation;
  }
}

export function useConnectedApp(notify: (message: string) => void) {
  const [client] = useState(() => new ConnectedClient(notify));
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => { client.setNotifier(notify); }, [client, notify]);
  useEffect(() => { client.start(); return client.stop; }, [client]);
  const tracking = useTracking(client, snapshot);
  return { ...snapshot, actions: client.actions, login: client.login, logout: client.logout, refresh: client.refresh, tracking };
}
