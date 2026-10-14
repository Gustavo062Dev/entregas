import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectedSnapshot } from '../connected';
import type { TrackingControls, TrackingStatus } from '../types';

/** Credentials remain inside ConnectedClient. React only receives status and delegates. */
export interface TrackingSource {
  trackingAvailable: () => boolean;
  startTracking: () => Promise<TrackingStatus>;
  stopTracking: () => Promise<TrackingStatus>;
  syncTracking: () => Promise<TrackingStatus>;
  getTrackingStatus: () => Promise<TrackingStatus>;
}

export const emptyTrackingStatus = (): TrackingStatus => ({ running: false, pending: 0, dropped: 0, error: '' });

export function trackingEnabled(source: TrackingSource, snapshot: ConnectedSnapshot) {
  return source.trackingAvailable() && snapshot.status === 'ready' && !snapshot.simulation
    && snapshot.user?.active === true && snapshot.user.role === 'driver' && !!snapshot.user.driverId;
}

export function useTracking(source: TrackingSource, snapshot: ConnectedSnapshot): TrackingControls {
  const enabled = trackingEnabled(source, snapshot);
  const owner = `${snapshot.apiUrl}|${snapshot.user?.id ?? ''}|${snapshot.user?.driverId ?? ''}`;
  const [status, setStatus] = useState<TrackingStatus>(emptyTrackingStatus);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const statusOwner = useRef('');
  const activeOperation = useRef(false);
  const inspection = useRef(false);
  const sequence = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    statusOwner.current = owner;
    let disposed = false;
    activeOperation.current = false;
    inspection.current = false;
    sequence.current += 1;
    setBusy(false);
    setStatus(emptyTrackingStatus());
    if (!enabled) return;
    const update = async (sync: boolean) => {
      if (disposed || activeOperation.current || inspection.current) return;
      const request = ++sequence.current;
      inspection.current = true;
      try {
        const next = await (sync ? source.syncTracking() : source.getTrackingStatus());
        if (!disposed && generation.current === current && sequence.current === request) setStatus(next);
      } catch (error) {
        if (!disposed && generation.current === current && sequence.current === request) setStatus(previous => ({ ...previous, error: error instanceof Error ? error.message : 'Não foi possível consultar o GPS.' }));
      } finally {
        if (!disposed && generation.current === current) inspection.current = false;
      }
    };
    // This restores/upload the same owner's queue; it never starts location capture.
    void update(true);
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') void update(false);
    }, 5_000);
    const foreground = () => { if (document.visibilityState !== 'hidden') void update(true); };
    document.addEventListener('visibilitychange', foreground);
    return () => {
      disposed = true;
      generation.current += 1;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [source, enabled, owner]);

  const run = useCallback(async (operation: () => Promise<TrackingStatus>) => {
    if (!enabled || activeOperation.current) return;
    const current = generation.current;
    sequence.current += 1;
    activeOperation.current = true;
    setBusy(true);
    try {
      const next = await operation();
      if (generation.current === current) setStatus(next);
    } catch (error) {
      if (generation.current === current) setStatus(previous => ({ ...previous, error: error instanceof Error ? error.message : 'Não foi possível alterar o GPS.' }));
    } finally {
      if (generation.current === current) { activeOperation.current = false; setBusy(false); }
    }
  }, [enabled]);
  const start = useCallback(() => run(source.startTracking), [run, source]);
  const stop = useCallback(() => run(source.stopTracking), [run, source]);
  const retry = useCallback(() => run(source.syncTracking), [run, source]);
  const ownStatus = enabled && statusOwner.current === owner;
  return { enabled, status: ownStatus ? status : emptyTrackingStatus(), busy: ownStatus && busy, start, stop, retry };
}
