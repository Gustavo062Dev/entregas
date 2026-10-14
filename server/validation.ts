import type { Command } from '../src/domain.ts';
import type { AppUser, GpsPoint } from '../src/types.ts';
import { HttpError } from './errors.ts';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= daysInMonth
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59
    && (offsetHour === undefined || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59));
}

export function validateTrackingStart(value: unknown): { deviceId: string } {
  const body = exactBody(value, ['deviceId']);
  if (!id(body.deviceId)) throw new HttpError(400, 'Informe um identificador válido do aparelho.');
  return { deviceId: body.deviceId };
}

export function validateTrackingStop(value: unknown): { sessionId: string; stoppedAt?: string } {
  const body = exactBody(value, ['sessionId'], ['stoppedAt']);
  if (!id(body.sessionId) || (body.stoppedAt !== undefined && !isoTimestamp(body.stoppedAt))) {
    throw new HttpError(400, 'Informe uma sessão e um horário de encerramento válidos.');
  }
  return { sessionId: body.sessionId, ...(body.stoppedAt === undefined ? {} : { stoppedAt: body.stoppedAt as string }) };
}

export function validateTrackingPoints(value: unknown): { sessionId: string; points: GpsPoint[] } {
  const body = exactBody(value, ['sessionId', 'points']);
  if (!id(body.sessionId) || !Array.isArray(body.points) || body.points.length < 1 || body.points.length > 100) {
    throw new HttpError(400, 'Envie entre 1 e 100 posições para uma sessão válida.');
  }
  const points = body.points.map((point): GpsPoint => {
    if (!record(point) || !keys(point, ['id', 'latitude', 'longitude', 'accuracy', 'recordedAt']) || !id(point.id)
      || typeof point.latitude !== 'number' || !Number.isFinite(point.latitude) || point.latitude < -90 || point.latitude > 90
      || typeof point.longitude !== 'number' || !Number.isFinite(point.longitude) || point.longitude < -180 || point.longitude > 180
      || typeof point.accuracy !== 'number' || !Number.isFinite(point.accuracy) || point.accuracy < 0 || point.accuracy > 100_000
      || !isoTimestamp(point.recordedAt)) {
      throw new HttpError(400, 'Uma das posições contém coordenadas, precisão ou horário inválidos.');
    }
    return { id: point.id, latitude: point.latitude, longitude: point.longitude, accuracy: point.accuracy, recordedAt: point.recordedAt };
  });
  return { sessionId: body.sessionId, points };
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'Informe um e-mail válido.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || /[\u0000-\u001f\u007f]/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Informe um e-mail válido.');
  return email;
}

export function validatePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128 || !value.trim()) {
    throw new HttpError(400, 'A senha deve ter entre 12 e 128 caracteres.');
  }
  return value;
}

export function validateUser(value: unknown): AppUser {
  if (!record(value) || !keys(value, ['id', 'name', 'email', 'role', 'active'], ['driverId'])
    || !id(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 100
    || /[\u0000-\u001f\u007f]/.test(value.name) || !['admin', 'manager', 'driver'].includes(String(value.role))
    || typeof value.active !== 'boolean' || (value.driverId !== undefined && !id(value.driverId))) {
    throw new HttpError(400, 'Revise os dados do usuário.');
  }
  return { id: value.id, name: value.name.trim(), email: normalizeEmail(value.email), role: value.role as AppUser['role'], active: value.active,
    ...(value.driverId !== undefined ? { driverId: value.driverId as string } : {}) };
}

export function validateCommand(value: unknown): Command {
  let valid = false;
  if (record(value)) {
    switch (value.type) {
      case 'assign': valid = keys(value, ['type', 'deliveryId', 'driverId']) && id(value.deliveryId) && (value.driverId === null || id(value.driverId)); break;
      case 'start': valid = keys(value, ['type', 'deliveryId', 'driverId']) && id(value.deliveryId) && id(value.driverId); break;
      case 'advance': valid = keys(value, ['type', 'deliveryId']) && id(value.deliveryId); break;
      case 'complete': valid = keys(value, ['type', 'deliveryId', 'receivedBy']) && id(value.deliveryId) && typeof value.receivedBy === 'string' && !!value.receivedBy.trim() && value.receivedBy.trim().length <= 120 && !/[\u0000-\u001f\u007f]/.test(value.receivedBy); break;
      case 'availability': valid = keys(value, ['type', 'driverId', 'online']) && id(value.driverId) && typeof value.online === 'boolean'; break;
      case 'save-user':
        if (keys(value, ['type', 'user'])) { validateUser(value.user); valid = true; }
        break;
      case 'toggle-user': valid = keys(value, ['type', 'id']) && id(value.id); break;
      case 'reset': valid = keys(value, ['type']); break;
    }
  }
  if (!valid) throw new HttpError(400, 'Comando inválido.');
  return value as Command;
}

export function exactBody(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!record(value) || !keys(value, required, optional)) throw new HttpError(400, 'Conteúdo da solicitação inválido.');
  return value;
}
