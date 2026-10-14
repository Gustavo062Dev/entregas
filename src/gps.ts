import { localDay } from './demo';
import type { GpsPoint, TrackingSession } from './types';

export const GPS_LIMITS = { accuracy: 50, speed: 50, gap: 120_000, age: 7 * 86_400_000, future: 30_000 };
const radians = (degrees: number) => degrees * Math.PI / 180;

/** Great-circle distance in metres; never accepts a client-supplied odometer. */
export function gpsDistance(a: Pick<GpsPoint, 'latitude' | 'longitude'>, b: Pick<GpsPoint, 'latitude' | 'longitude'>) {
  const latitude = radians(b.latitude - a.latitude);
  const longitude = radians(b.longitude - a.longitude);
  const value = Math.sin(latitude / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(longitude / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(Math.min(1, Math.max(0, value))), Math.sqrt(Math.max(0, 1 - value)));
}

export interface GpsResult {
  session: TrackingSession; accepted: boolean; meters: number; gap: boolean; reason?: string; fromRecordedAt?: string;
}

export function applyGpsPoint(session: TrackingSession, point: GpsPoint, now: number): GpsResult {
  const reject = (reason: string): GpsResult => ({ session: { ...session, rejectedPoints: session.rejectedPoints + 1 }, accepted: false, meters: 0, gap: false, reason });
  const time = Date.parse(point.recordedAt);
  if (!Number.isFinite(time) || !Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90
    || !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180
    || !Number.isFinite(point.accuracy) || point.accuracy <= 0) return reject('invalid');
  if (time > now + GPS_LIMITS.future || now - time > GPS_LIMITS.age) return reject('time');
  if (point.accuracy > GPS_LIMITS.accuracy) return reject('accuracy');
  const previous = session.lastPoint;
  const elapsed = previous ? time - Date.parse(previous.recordedAt) : 0;
  if (previous && elapsed <= 0) return reject('order');
  const gap = Boolean(previous && elapsed > GPS_LIMITS.gap);
  if (previous && !gap && gpsDistance(previous, point) / (elapsed / 1000) > GPS_LIMITS.speed) return reject('speed');
  const anchor = session.anchor && time - Date.parse(session.anchor.recordedAt) <= GPS_LIMITS.gap ? session.anchor : previous;
  const distance = anchor ? gpsDistance(anchor, point) : 0;
  const threshold = Math.max(8, ((anchor?.accuracy ?? point.accuracy) + point.accuracy) / 2);
  const moves = Boolean(anchor && !gap && distance >= threshold);
  const meters = moves ? distance : 0;
  return {
    accepted: true, meters, gap, ...(moves ? { fromRecordedAt: anchor!.recordedAt } : {}),
    session: { ...session, meters: session.meters + meters, acceptedPoints: session.acceptedPoints + 1,
      gaps: session.gaps + (gap ? 1 : 0), lastPoint: { ...point },
      anchor: !anchor || gap || moves ? { ...point } : { ...anchor } },
  };
}

/** Split a measured segment at local midnight, instead of charging its full distance to one day. */
export function splitGpsDistance(fromRecordedAt: string, toRecordedAt: string, meters: number): Array<{ date: string; meters: number }> {
  const from = Date.parse(fromRecordedAt), to = Date.parse(toRecordedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || !Number.isFinite(meters) || meters <= 0) return [];
  const firstDay = localDay(new Date(from)), lastDay = localDay(new Date(to));
  if (firstDay === lastDay) return [{ date: lastDay, meters }];
  // Accepted GPS segments cannot span a gap over two minutes. Intl supplies the time zone boundary.
  let low = from, high = to;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDay(new Date(middle)) === firstDay) low = middle; else high = middle;
  }
  const before = meters * (high - from) / (to - from);
  return [{ date: firstDay, meters: before }, { date: lastDay, meters: meters - before }].filter(item => item.meters > 0);
}
