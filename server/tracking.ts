import { createHash, randomUUID } from 'node:crypto';
import { deriveState, localDay } from '../src/demo.ts';
import { applyGpsPoint, splitGpsDistance } from '../src/gps.ts';
import type { AppState, AppUser, GpsPoint, TrackingSession } from '../src/types.ts';
import { HttpError } from './errors.ts';

export interface PointReceipts {
  hash: (sessionId: string, pointId: string) => string | undefined;
  remember: (sessionId: string, pointId: string, hash: string) => void;
  owner: (sessionId: string) => string | undefined;
  bind: (sessionId: string, userId: string) => void;
}

function operationalDriver(state: AppState, user: AppUser, simulation: boolean) {
  if (simulation) throw new HttpError(403, 'O GPS real não está disponível na demonstração.');
  if (user.role !== 'driver' || !user.driverId) throw new HttpError(403, 'Somente o entregador pode registrar sua localização.');
  if (!state.users.some(item => item.id === user.id && item.active && item.role === 'driver' && item.driverId === user.driverId)) {
    throw new HttpError(403, 'Sua conta não está ativa para este entregador.');
  }
  const driver = state.drivers.find(item => item.id === user.driverId);
  if (!driver) throw new HttpError(403, 'Esta conta não possui um entregador vinculado.');
  return driver;
}

function ownedSession(state: AppState, user: AppUser, simulation: boolean, sessionId: string, receipts: PointReceipts) {
  const driver = operationalDriver(state, user, simulation);
  const session = (state.trackingSessions ?? []).find(item => item.id === sessionId);
  // Do not disclose whether another driver's session exists.
  if (!session || session.driverId !== driver.id || receipts.owner(sessionId) !== user.id) throw new HttpError(403, 'Esta sessão de GPS não pertence à sua conta.');
  return session;
}

export function startTracking(state: AppState, user: AppUser, simulation: boolean, deviceId: string, now: number, receipts: PointReceipts) {
  const driver = operationalDriver(state, user, simulation);
  if (driver.status === 'offline' || !driver.shiftStartedAt) throw new HttpError(403, 'Inicie seu turno antes de ativar o GPS.');
  const active = (state.trackingSessions ?? []).find(item => item.driverId === driver.id && !item.endedAt);
  if (active) {
    if (receipts.owner(active.id) !== user.id) throw new HttpError(409, 'Existe uma sessão de GPS de outra conta neste entregador. Encerre o turno antes de ativar o GPS.');
    if (active.deviceId !== deviceId) throw new HttpError(409, 'O GPS deste turno já está ativo em outro aparelho. Encerre-o primeiro.');
    return { state, trackingSession: active };
  }
  const trackingSession: TrackingSession = { id: randomUUID(), driverId: driver.id, deviceId,
    startedAt: new Date(now).toISOString(), meters: 0, acceptedPoints: 0, rejectedPoints: 0, gaps: 0 };
  receipts.bind(trackingSession.id, user.id);
  return { state: { ...state, trackingSessions: [...(state.trackingSessions ?? []), trackingSession] }, trackingSession };
}

export function stopTracking(state: AppState, user: AppUser, simulation: boolean, sessionId: string, stoppedAt: string | undefined, now: number, receipts: PointReceipts) {
  const current = ownedSession(state, user, simulation, sessionId, receipts);
  const end = stoppedAt === undefined ? now : Date.parse(stoppedAt);
  if (end < Date.parse(current.startedAt) || end > now + 30_000) throw new HttpError(422, 'O encerramento deve ocorrer após o início e não pode estar no futuro.');
  if (current.endedAt) return { state, trackingSession: current };
  // GPS timestamps may lead the device clock within the accepted 30-second
  // tolerance. Preserve accepted captures without trapping a stopped device in
  // retries of a fixed stop timestamp.
  const canonicalEnd = Math.max(end, current.lastPoint ? Date.parse(current.lastPoint.recordedAt) : end);
  const trackingSession = { ...current, endedAt: new Date(canonicalEnd).toISOString() };
  return { state: { ...state, trackingSessions: (state.trackingSessions ?? []).map(item => item.id === sessionId ? trackingSession : item) }, trackingSession };
}

function pointHash(point: GpsPoint) {
  // A canonical field order makes object key ordering irrelevant while retaining the original values.
  return createHash('sha256').update(JSON.stringify([point.id, point.latitude, point.longitude, point.accuracy, point.recordedAt])).digest('hex');
}

export function recordTrackingPoints(state: AppState, user: AppUser, simulation: boolean, sessionId: string, points: GpsPoint[], receipts: PointReceipts, now: number) {
  let session = ownedSession(state, user, simulation, sessionId, receipts);
  const next = structuredClone(state);
  const driver = next.drivers.find(item => item.id === session.driverId)!;
  const ackIds: string[] = [];
  let accepted = 0, rejected = 0, duplicates = 0, changed = false;
  // The server is responsible for ordering each offline upload batch.
  for (const point of [...points].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt))) {
    const hash = pointHash(point);
    const original = receipts.hash(sessionId, point.id);
    if (original !== undefined) {
      if (original !== hash) throw new HttpError(409, 'Esta posição já foi registrada com outros dados.');
      duplicates++;
      ackIds.push(point.id);
      continue;
    }
    const time = Date.parse(point.recordedAt);
    const inWindow = time >= Date.parse(session.startedAt) && (!session.endedAt || time <= Date.parse(session.endedAt));
    // A cached first Android fix or an upload made after a server-side stop must
    // not block the valid captures in the same offline batch. Acknowledge its
    // explicit rejection, persist its receipt, and never move the GPS or odometer.
    const result: ReturnType<typeof applyGpsPoint> = inWindow ? applyGpsPoint(session, point, now)
      : { session: { ...session, rejectedPoints: session.rejectedPoints + 1 }, accepted: false, meters: 0, gap: false, reason: 'window' };
    session = result.session;
    receipts.remember(sessionId, point.id, hash);
    changed = true;
    ackIds.push(point.id);
    if (result.accepted) accepted++; else rejected++;
    const dayFor = (date: string) => {
      next.gpsDays ??= [];
      let day = next.gpsDays.find(item => item.driverId === driver.id && item.date === date);
      if (!day) { day = { driverId: driver.id, date, meters: 0, acceptedPoints: 0, gaps: 0 }; next.gpsDays.push(day); }
      return day;
    };
    if (result.accepted || result.gap) {
      const day = dayFor(localDay(new Date(point.recordedAt)));
      day.acceptedPoints += Number(result.accepted);
      day.gaps += Number(result.gap);
    }
    if (result.accepted && result.meters > 0 && result.fromRecordedAt) {
      for (const segment of splitGpsDistance(result.fromRecordedAt, point.recordedAt, result.meters)) dayFor(segment.date).meters += segment.meters;
    }
    if (result.accepted) {
      if (!driver.gps || Date.parse(point.recordedAt) > Date.parse(driver.gps.recordedAt)) {
        driver.gps = { ...point, receivedAt: new Date(now).toISOString() };
      }
      // Associate delayed uploads with the delivery active at capture time, including a
      // delivery completed before its offline points reached the server.
      const fromTime = result.fromRecordedAt === undefined ? undefined : Date.parse(result.fromRecordedAt);
      const trip = fromTime === undefined ? undefined : next.trips.find(item => item.driverId === driver.id && item.distanceSource === 'gps'
        && Date.parse(item.startedAt) <= fromTime && (!item.finishedAt || time <= Date.parse(item.finishedAt)));
      if (trip) {
        trip.distanceMeters = (trip.distanceMeters ?? 0) + result.meters;
        trip.km = trip.distanceMeters / 1000;
      }
    }
  }
  if (changed) next.trackingSessions = (next.trackingSessions ?? []).map(item => item.id === sessionId ? session : item);
  return { state: changed ? deriveState(next) : state, ackIds: [...new Set(ackIds)], accepted, rejected, duplicates, active: !session.endedAt };
}

/** Close capture windows when a command ends a shift or changes its account binding. */
export function closeUnavailableTracking(state: AppState, now: number): AppState {
  let changed = false;
  const trackingSessions = (state.trackingSessions ?? []).map(session => {
    if (session.endedAt) return session;
    const driver = state.drivers.find(item => item.id === session.driverId);
    const activeOwner = state.users.some(item => item.role === 'driver' && item.driverId === session.driverId && item.active);
    if (driver && driver.status !== 'offline' && driver.shiftStartedAt && activeOwner) return session;
    changed = true;
    const endedAt = new Date(Math.max(now, Date.parse(session.startedAt), session.lastPoint ? Date.parse(session.lastPoint.recordedAt) : now)).toISOString();
    return { ...session, endedAt };
  });
  return changed ? { ...state, trackingSessions } : state;
}
