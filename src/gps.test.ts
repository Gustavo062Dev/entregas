import { describe, expect, it } from 'vitest';
import { applyGpsPoint, gpsDistance, splitGpsDistance } from './gps';
import type { GpsPoint, TrackingSession } from './types';

const NOW = Date.parse('2026-10-13T14:00:00Z');
const LATITUDE = -23.55052;
const LONGITUDE = -46.633308;

function session(): TrackingSession {
  return { id: 'session-test', driverId: 'driver-test', deviceId: 'device-test', startedAt: new Date(NOW).toISOString(),
    meters: 0, acceptedPoints: 0, rejectedPoints: 0, gaps: 0 };
}

function point(seconds: number, latitude = LATITUDE, overrides: Partial<GpsPoint> = {}): GpsPoint {
  return { id: `sample-${seconds}`, latitude, longitude: LONGITUDE, accuracy: 5,
    recordedAt: new Date(NOW + seconds * 1_000).toISOString(), ...overrides };
}

describe('GPS: distância medida e qualidade das amostras', () => {
  it('calcula a rota curta ao atravessar o meridiano de 180 graus e trata os pontos antipodais', () => {
    expect(gpsDistance({ latitude: 0, longitude: 179.999 }, { latitude: 0, longitude: -179.999 })).toBeCloseTo(222.3899, 2);
    expect(gpsDistance({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 })).toBeCloseTo(20_015_086.796, 2);
    expect(gpsDistance({ latitude: LATITUDE, longitude: LONGITUDE }, { latitude: LATITUDE, longitude: LONGITUDE })).toBe(0);
  });

  it('a primeira localização cria a âncora sem inventar quilômetros', () => {
    const initial = session();
    const first = point(0);
    const result = applyGpsPoint(initial, first, NOW);
    expect(result.accepted).toBe(true);
    expect(result.meters).toBe(0);
    expect(result.session).toMatchObject({ meters: 0, acceptedPoints: 1, rejectedPoints: 0, gaps: 0,
      lastPoint: first, anchor: first });
    expect(initial).toEqual(session());
  });

  it('mede a distância geodésica entre coordenadas conhecidas', () => {
    const first = applyGpsPoint(session(), point(0), NOW).session;
    // Um milésimo de grau no mesmo meridiano corresponde a cerca de 111,195 m.
    const result = applyGpsPoint(first, point(10, LATITUDE + 0.001), NOW + 10_000);
    expect(result.accepted).toBe(true);
    expect(result.meters).toBeCloseTo(111.195, 2);
    expect(result.session.meters).toBeCloseTo(111.195, 2);
    expect(result.session.acceptedPoints).toBe(2);
  });

  it('descarta uma localização imprecisa sem contaminar a próxima medição', () => {
    const first = applyGpsPoint(session(), point(0), NOW).session;
    const noisy = applyGpsPoint(first, point(5, LATITUDE + 0.02, { accuracy: 51 }), NOW + 5_000);
    expect(noisy.accepted).toBe(false);
    expect(noisy.reason).toBeTruthy();
    expect(noisy.meters).toBe(0);
    expect(noisy.session).toMatchObject({ lastPoint: first.lastPoint, anchor: first.anchor, rejectedPoints: 1 });
    const recovered = applyGpsPoint(noisy.session, point(10, LATITUDE + 0.001), NOW + 10_000);
    expect(recovered.accepted).toBe(true);
    expect(recovered.meters).toBeCloseTo(111.195, 2);
  });

  it('recusa teletransporte acima da velocidade plausível e mantém a âncora anterior', () => {
    const first = applyGpsPoint(session(), point(0), NOW).session;
    const teleport = applyGpsPoint(first, point(10, LATITUDE + 1), NOW + 10_000);
    expect(teleport.accepted).toBe(false);
    expect(teleport.meters).toBe(0);
    expect(teleport.session.anchor).toEqual(first.anchor);
    const recovered = applyGpsPoint(teleport.session, point(20, LATITUDE + 0.001), NOW + 20_000);
    expect(recovered.accepted).toBe(true);
    expect(recovered.session.meters).toBeCloseTo(111.195, 2);
  });

  it('não soma o ruído de um entregador parado nem desloca a âncora a cada oscilação', () => {
    let current = applyGpsPoint(session(), point(0), NOW).session;
    const anchor = current.anchor;
    for (let index = 1; index <= 12; index++) {
      const jitter = point(index * 5, LATITUDE + (index % 2 ? 0.000008 : -0.000008));
      const result = applyGpsPoint(current, jitter, NOW + index * 5_000);
      expect(result.accepted).toBe(true);
      expect(result.meters).toBe(0);
      current = result.session;
    }
    expect(current.meters).toBe(0);
    expect(current.anchor).toEqual(anchor);
    const moving = applyGpsPoint(current, point(70, LATITUDE + 0.001), NOW + 70_000);
    expect(moving.accepted).toBe(true);
    expect(moving.meters).toBeCloseTo(111.195, 2);
  });

  it('recusa amostras antigas e repetidas no tempo sem retornar a localização anterior', () => {
    const current = applyGpsPoint(session(), point(10), NOW + 10_000).session;
    for (const sample of [point(0, LATITUDE + 0.001), point(10, LATITUDE + 0.001, { id: 'different-id' })]) {
      const result = applyGpsPoint(current, sample, NOW + 20_000);
      expect(result.accepted).toBe(false);
      expect(result.meters).toBe(0);
      expect(result.session.lastPoint).toEqual(current.lastPoint);
      expect(result.session.anchor).toEqual(current.anchor);
    }
  });

  it('recusa relógio mais de 30 segundos no futuro e histórico mais antigo que sete dias', () => {
    const future = applyGpsPoint(session(), point(31), NOW);
    const expired = applyGpsPoint(session(), point(-7 * 24 * 60 * 60 - 1), NOW);
    for (const result of [future, expired]) {
      expect(result.accepted).toBe(false);
      expect(result.meters).toBe(0);
      expect(result.session.lastPoint).toBeUndefined();
      expect(result.reason).toBeTruthy();
    }
  });

  it('interrompe a medição durante uma lacuna e retoma da nova âncora sem ligar os dois extremos', () => {
    const first = applyGpsPoint(session(), point(0), NOW).session;
    const gap = applyGpsPoint(first, point(121, LATITUDE + 0.05), NOW + 121_000);
    expect(gap.accepted).toBe(true);
    expect(gap.gap).toBe(true);
    expect(gap.meters).toBe(0);
    expect(gap.session.gaps).toBe(1);
    expect(gap.session.anchor).toEqual(point(121, LATITUDE + 0.05));
    const resumed = applyGpsPoint(gap.session, point(131, LATITUDE + 0.051), NOW + 131_000);
    expect(resumed.accepted).toBe(true);
    expect(resumed.gap).toBe(false);
    expect(resumed.meters).toBeCloseTo(111.195, 2);
    expect(resumed.session.meters).toBeCloseTo(111.195, 2);
  });

  it('a lacuna de exatamente 120 segundos ainda permite medir movimento plausível', () => {
    const first = applyGpsPoint(session(), point(0), NOW).session;
    const result = applyGpsPoint(first, point(120, LATITUDE + 0.001), NOW + 120_000);
    expect(result.accepted).toBe(true);
    expect(result.gap).toBe(false);
    expect(result.meters).toBeCloseTo(111.195, 2);
  });

  it('a precisão do GPS determina quando um deslocamento deixa de ser ruído', () => {
    const first = applyGpsPoint(session(), point(0, LATITUDE, { accuracy: 25 }), NOW).session;
    const insideUncertainty = applyGpsPoint(first, point(10, LATITUDE + 0.00018, { accuracy: 25 }), NOW + 10_000);
    expect(insideUncertainty.accepted).toBe(true);
    expect(insideUncertainty.meters).toBe(0);
    const beyondUncertainty = applyGpsPoint(insideUncertainty.session, point(20, LATITUDE + 0.0003, { accuracy: 25 }), NOW + 20_000);
    expect(beyondUncertainty.accepted).toBe(true);
    expect(beyondUncertainty.meters).toBeCloseTo(33.3585, 2);
  });

  it('divide metros proporcionalmente à meia-noite local de São Paulo sem perder distância', () => {
    const split = splitGpsDistance('2026-10-14T02:59:50.000Z', '2026-10-14T03:00:30.000Z', 400);
    expect(split).toEqual([{ date: '2026-10-13', meters: 100 }, { date: '2026-10-14', meters: 300 }]);
    expect(splitGpsDistance('2026-10-14T03:00:00.000Z', '2026-10-14T03:00:10.000Z', 100))
      .toEqual([{ date: '2026-10-14', meters: 100 }]);
  });

  it('depois de uma longa parada a medição não atribui movimento a uma âncora de uma hora atrás', () => {
    let current = applyGpsPoint(session(), point(0), NOW).session;
    for (let minute = 1; minute <= 60; minute++) {
      current = applyGpsPoint(current, point(minute * 60), NOW + minute * 60_000).session;
    }
    const moving = applyGpsPoint(current, point(3_610, LATITUDE + 0.001), NOW + 3_610_000);
    expect(moving.accepted).toBe(true);
    expect(moving.meters).toBeCloseTo(111.195, 2);
    expect(Date.parse(moving.fromRecordedAt!)).toBeGreaterThanOrEqual(NOW + 3_490_000);
    expect(moving.session.gaps).toBe(0);
  });
});
