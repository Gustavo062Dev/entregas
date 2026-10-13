import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createDemoState, deriveState, localDay } from './demo';
import type { AppActions, AppState, AppUser } from './types';

export const STORAGE_KEY = 'rota.demo.state.v1';
export { transition } from './domain';
import { transition, type Command } from './domain';

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function textFields(value: Record<string, unknown>, fields: string[]) { return fields.every(f => typeof value[f] === 'string'); }
function validPosition(value: unknown) { return isRecord(value) && ['x', 'y'].every(k => typeof value[k] === 'number' && Number.isFinite(value[k]) && (value[k] as number) >= 0 && (value[k] as number) <= 100); }
function validDate(value: unknown) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function uniqueIds(items: Array<Record<string, unknown>>) { return new Set(items.map(i => i.id)).size === items.length; }

export function readState(raw: string | null, today = localDay()): AppState {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (value?.version === 1 && /^\d{4}-\d{2}-\d{2}$/.test(value.demoDate) && validDate(value.demoDate)
      && Array.isArray(value.drivers) && Array.isArray(value.deliveries) && Array.isArray(value.trips) && Array.isArray(value.users)
      && value.drivers.length && value.drivers.every((d: unknown) => isRecord(d) && textFields(d, ['id', 'name', 'initials', 'color', 'phone', 'vehicle']) && ['available', 'on_route', 'offline'].includes(String(d.status)) && validPosition(d.position) && (d.shiftStartedAt === null || validDate(d.shiftStartedAt)))
      && value.deliveries.every((d: unknown) => isRecord(d) && textFields(d, ['id', 'code', 'customer', 'address', 'neighborhood', 'phone', 'window', 'note']) && ['pending', 'in_transit', 'delivered'].includes(String(d.status)) && validPosition(d.position) && typeof d.estimatedKm === 'number' && Number.isFinite(d.estimatedKm) && d.estimatedKm >= 0 && (d.driverId === null || value.drivers.some((driver: {id: string}) => driver.id === d.driverId)) && (d.deliveredAt === undefined || validDate(d.deliveredAt)) && (d.receivedBy === undefined || typeof d.receivedBy === 'string'))
      && value.trips.every((t: unknown) => isRecord(t) && textFields(t, ['id', 'driverId', 'deliveryId', 'date']) && /^\d{4}-\d{2}-\d{2}$/.test(String(t.date)) && validDate(t.date) && validDate(t.startedAt) && (t.finishedAt === undefined || validDate(t.finishedAt)) && typeof t.km === 'number' && Number.isFinite(t.km) && t.km >= 0 && typeof t.progress === 'number' && t.progress >= 0 && t.progress <= 1 && value.drivers.some((d: {id: string}) => d.id === t.driverId))
      && value.users.every((u: unknown) => isRecord(u) && textFields(u, ['id', 'name', 'email']) && ['admin', 'manager', 'driver'].includes(String(u.role)) && typeof u.active === 'boolean' && (u.driverId === undefined || value.drivers.some((d: {id: string}) => d.id === u.driverId)))
      && [value.drivers, value.deliveries, value.trips, value.users].every(uniqueIds)) return deriveState({ ...value, demoDate: today });
  } catch { /* Corrupt local data must not prevent the demonstration from starting. */ }
  return createDemoState();
}

export function useDemo(notify: (message: string) => void): { state: AppState; actions: AppActions } {
  const [state, setState] = useState(() => { try { return readState(localStorage.getItem(STORAGE_KEY)); } catch { return createDemoState(); } });
  const current = useRef(state);
  useEffect(() => {
    const receive = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) { const state = readState(event.newValue); current.current = state; setState(state); }
    };
    window.addEventListener('storage', receive);
    return () => window.removeEventListener('storage', receive);
  }, []);
  const run = useCallback((command: Command) => {
    const previous = current.current;
    const result = transition(previous, command);
    current.current = result.state; setState(result.state);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(result.state)); }
    catch { notify('O armazenamento local não está disponível. As alterações serão mantidas apenas nesta sessão.'); }
    notify(result.message);
    return result.state !== previous;
  }, [notify]);
  const actions = useMemo<AppActions>(() => ({
    assignDelivery: (deliveryId, driverId) => run({ type: 'assign', deliveryId, driverId }),
    startRoute: (deliveryId, driverId) => run({ type: 'start', deliveryId, driverId }),
    advanceRoute: deliveryId => run({ type: 'advance', deliveryId }),
    completeDelivery: (deliveryId, receivedBy) => run({ type: 'complete', deliveryId, receivedBy }),
    setDriverAvailability: (driverId, online) => run({ type: 'availability', driverId, online }),
    saveUser: user => run({ type: 'save-user', user }),
    toggleUser: id => run({ type: 'toggle-user', id }),
    resetDemo: () => run({ type: 'reset' }), notify,
  }), [run, notify]);
  return { state, actions };
}
