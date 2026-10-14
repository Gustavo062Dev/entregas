import { describe, expect, it, vi } from 'vitest';
import { createDemoState } from '../demo';
import type { ConnectedSnapshot } from '../connected';
import { trackingEnabled, type TrackingSource } from './useTracking';

const source = (native = true): TrackingSource => ({
  trackingAvailable: () => native,
  startTracking: vi.fn(), stopTracking: vi.fn(), syncTracking: vi.fn(), getTrackingStatus: vi.fn(),
});
const snapshot = (): ConnectedSnapshot => ({
  user: createDemoState().users.find(item => item.role === 'driver')!,
  state: createDemoState(), status: 'ready', syncing: false, error: '',
  apiUrl: 'https://api.example.com', simulation: false,
});

describe('Disponibilidade da captura de GPS', () => {
  it('restringe os controles à conta ativa de entregador no Android em produção', () => {
    expect(trackingEnabled(source(), snapshot())).toBe(true);
    expect(trackingEnabled(source(false), snapshot())).toBe(false);
    for (const patch of [
      { status: 'loading' as const }, { status: 'signed-out' as const }, { simulation: true }, { user: null },
      { user: { ...snapshot().user!, role: 'admin' as const } },
      { user: { ...snapshot().user!, active: false } },
      { user: { ...snapshot().user!, driverId: undefined } },
    ]) expect(trackingEnabled(source(), { ...snapshot(), ...patch })).toBe(false);
  });
});
