import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoState } from './demo';
import { readState, transition } from './store';

const seed = () => createDemoState('2026-10-13');
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-13T14:00:00Z')); });
afterEach(() => vi.useRealTimers());

describe('Fluxo demonstrativo de entregas', () => {
  it('contabiliza os quilômetros do dia a partir das viagens, incluindo rota em andamento', () => {
    const state = seed();
    const camila = state.drivers.find(d => d.id === 'd2')!;
    expect(camila.kmToday).toBeCloseTo(10.9);
    expect(state.trips.filter(t => t.date !== state.demoDate).length).toBe(12);
  });
  it('permite atribuir apenas entregas pendentes a um entregador ativo', () => {
    const state = seed();
    expect(transition(state, { type: 'assign', deliveryId: 'e5', driverId: 'd1' }).state.deliveries.find(d => d.id === 'e5')?.driverId).toBe('d1');
    expect(transition(state, { type: 'assign', deliveryId: 'e2', driverId: 'd1' }).state).toBe(state);
    expect(transition(state, { type: 'assign', deliveryId: 'e5', driverId: 'missing' }).state).toBe(state);
  });
  it('percorre uma rota dentro do app e confirma recebimento sem duplicar distância', () => {
    let state = seed();
    const initialKm = state.drivers[0].kmToday;
    state = transition(state, { type: 'start', deliveryId: 'e1', driverId: 'd1' }).state;
    expect(state.deliveries[0].status).toBe('in_transit');
    expect(state.drivers[0].status).toBe('on_route');
    expect(transition(state, { type: 'complete', deliveryId: 'e1', receivedBy: 'Portaria' }).state).toBe(state);
    for (let i = 0; i < 4; i++) state = transition(state, { type: 'advance', deliveryId: 'e1' }).state;
    expect(state.drivers[0].kmToday).toBeCloseTo(initialKm + 3.8);
    expect(state.drivers[0].position).toEqual(state.deliveries[0].position);
    expect(transition(state, { type: 'advance', deliveryId: 'e1' }).state).toBe(state);
    expect(transition(state, { type: 'complete', deliveryId: 'e1', receivedBy: '   ' }).state).toBe(state);
    state = transition(state, { type: 'complete', deliveryId: 'e1', receivedBy: '  João, portaria  ' }).state;
    expect(state.deliveries[0].status).toBe('delivered');
    expect(state.deliveries[0].receivedBy).toBe('João, portaria');
    expect(state.drivers[0].status).toBe('available');
    expect(state.trips.find(t => t.deliveryId === 'e1')?.finishedAt).toBeTruthy();
    expect(transition(state, { type: 'complete', deliveryId: 'e1', receivedBy: 'João' }).state).toBe(state);
  });
  it('protege contra iniciar duas rotas e encerrar o turno durante uma entrega', () => {
    const state = transition(seed(), { type: 'start', deliveryId: 'e1', driverId: 'd1' }).state;
    expect(transition(state, { type: 'start', deliveryId: 'e4', driverId: 'd1' }).state).toBe(state);
    expect(transition(state, { type: 'availability', driverId: 'd1', online: false }).state).toBe(state);
  });
  it('impede rota em turno encerrado, usuário desativado ou entrega de outro entregador', () => {
    let state = transition(seed(), { type: 'availability', driverId: 'd1', online: false }).state;
    expect(transition(state, { type: 'start', deliveryId: 'e1', driverId: 'd1' }).state).toBe(state);
    state = transition(state, { type: 'availability', driverId: 'd1', online: true }).state;
    expect(transition(state, { type: 'start', deliveryId: 'e1', driverId: 'd3' }).state).toBe(state);
    state = transition(state, { type: 'toggle-user', id: 'u3' }).state;
    expect(transition(state, { type: 'availability', driverId: 'd1', online: true }).state).toBe(state);
    expect(transition(state, { type: 'start', deliveryId: 'e1', driverId: 'd1' }).state).toBe(state);
  });
  it('não altera o estado original em uma transição', () => {
    const state = seed();
    const snapshot = JSON.stringify(state);
    transition(state, { type: 'start', deliveryId: 'e1', driverId: 'd1' });
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe('Usuários locais', () => {
  it('adiciona, normaliza, edita e desativa um usuário', () => {
    let state = seed();
    state = transition(state, { type: 'save-user', user: { id: 'new', name: '  José Silva ', email: ' JOSE@EXAMPLE.COM ', role: 'manager', active: true } }).state;
    expect(state.users.at(-1)?.email).toBe('jose@example.com');
    expect(state.users.at(-1)?.name).toBe('José Silva');
    state = transition(state, { type: 'toggle-user', id: 'new' }).state;
    expect(state.users.at(-1)?.active).toBe(false);
  });
  it('recusa e-mail duplicado ou inválido e protege o último administrador', () => {
    const state = seed();
    const user = { id: 'new', name: 'Outro', email: 'gestor@example.com', role: 'manager' as const, active: true };
    expect(transition(state, { type: 'save-user', user }).state).toBe(state);
    expect(transition(state, { type: 'save-user', user: { ...user, email: 'invalido' } }).state).toBe(state);
    expect(transition(state, { type: 'toggle-user', id: 'u1' }).state).toBe(state);
    expect(transition(state, { type: 'save-user', user: { ...state.users[0], role: 'manager' } }).state).toBe(state);
  });
  it('não permite desativar ou desvincular usuário durante rota', () => {
    const state = seed();
    expect(transition(state, { type: 'toggle-user', id: 'u4' }).state).toBe(state);
    expect(transition(state, { type: 'save-user', user: { ...state.users[3], role: 'manager' } }).state).toBe(state);
  });
  it('desativar ou desvincular pela edição deixa o entregador offline', () => {
    const state = seed();
    const result = transition(state, { type: 'save-user', user: { ...state.users[2], active: false } }).state;
    expect(result.drivers[0].status).toBe('offline');
    expect(result.drivers[0].shiftStartedAt).toBeNull();
    const unlink = transition(state, { type: 'save-user', user: { ...state.users[2], role: 'manager' } }).state;
    expect(unlink.drivers[0].status).toBe('offline');
  });
  it('cadastro de entregador cria um perfil vinculado para o app', () => {
    const state = transition(seed(), { type: 'save-user', user: { id: 'new', name: 'Nova Entregadora', email: 'nova@example.com', role: 'driver', active: true } }).state;
    const user = state.users.at(-1)!;
    expect(user.driverId).toBeTruthy();
    expect(state.drivers.find(d => d.id === user.driverId)?.name).toBe('Nova Entregadora');
    expect(state.drivers.find(d => d.id === user.driverId)?.status).toBe('offline');
  });
  it('editar identificação atualiza o perfil exibido no app e no mapa', () => {
    const state = seed();
    const updated = transition(state, { type: 'save-user', user: { ...state.users[2], name: 'Rafael Oliveira' } }).state;
    expect(updated.drivers[0].name).toBe('Rafael Oliveira');
    expect(updated.drivers[0].initials).toBe('RO');
  });
});

describe('Persistência', () => {
  it('recupera dados inválidos sem quebrar o mapa ou as telas', () => {
    const raw = seed();
    delete (raw.deliveries[0] as Partial<typeof raw.deliveries[0]>).position;
    expect(readState(JSON.stringify(raw)).deliveries[0].position).toBeDefined();
    expect(readState('{invalid').drivers.length).toBe(4);
  });
  it('reabertura no dia seguinte preserva histórico sem mostrar quilômetros antigos como de hoje', () => {
    const stored = seed();
    const state = readState(JSON.stringify(stored), '2026-10-14');
    expect(state.trips).toEqual(stored.trips);
    expect(state.demoDate).toBe('2026-10-14');
    expect(state.drivers[0].kmToday).toBe(0);
    const result = transition(state, { type: 'start', deliveryId: 'e1', driverId: 'd1' }, '2026-10-14T14:00:00Z');
    expect(result.state.trips.at(-1)?.date).toBe('2026-10-14');
  });
});
