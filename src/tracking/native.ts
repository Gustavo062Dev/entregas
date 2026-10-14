import { registerPlugin } from '@capacitor/core';
import type { TrackingStatus } from '../types';

export interface TrackingCredentials {
  apiUrl: string;
  token: string;
  userId: string;
  driverId: string;
  expiresAt: string;
}

export interface TrackingStart extends TrackingCredentials {
  sessionId: string;
  deviceId: string;
}

interface RotaTrackingPlugin {
  getDeviceId(): Promise<{ deviceId: string }>;
  start(options: TrackingStart): Promise<TrackingStatus>;
  stop(): Promise<TrackingStatus>;
  getStatus(): Promise<TrackingStatus>;
  sync(options: TrackingCredentials): Promise<TrackingStatus>;
  openSettings(): Promise<void>;
}

export const RotaTracking = registerPlugin<RotaTrackingPlugin>('RotaTracking');
