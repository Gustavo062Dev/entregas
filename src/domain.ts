import { createDemoState, deriveState, localDay } from './demo';
import type { AppState, AppUser } from './types';

export type Command =
  | { type: 'assign'; deliveryId: string; driverId: string | null }
  | { type: 'start'; deliveryId: string; driverId: string }
  | { type: 'advance'; deliveryId: string }
  | { type: 'complete'; deliveryId: string; receivedBy: string }
  | { type: 'availability'; driverId: string; online: boolean }
  | { type: 'save-user'; user: AppUser }
  | { type: 'toggle-user'; id: string }
  | { type: 'reset' };

export function transition(state: AppState, command: Command, now = new Date().toISOString(), options: { simulation?: boolean } = {}): { state: AppState; message: string } {
  const simulation = options.simulation ?? true;
  const reject = (message: string) => ({ state, message });
  let next: AppState = structuredClone(state);
  next.demoDate = localDay(new Date(now));
  let message = '';
  const active = (driverId: string) => state.users.some(u => u.driverId === driverId && u.active);
  switch (command.type) {
    case 'reset': return { state: createDemoState(), message: 'Dados de demonstração restaurados.' };
    case 'assign': {
      const delivery = next.deliveries.find(d => d.id === command.deliveryId);
      if (!delivery || delivery.status !== 'pending') return reject('Só é possível atribuir entregas pendentes.');
      if (command.driverId && (!next.drivers.some(d => d.id === command.driverId) || !active(command.driverId))) return reject('Selecione um entregador com usuário ativo.');
      delivery.driverId = command.driverId;
      message = command.driverId ? 'Entregador atribuído à entrega.' : 'Atribuição removida.';
      break;
    }
    case 'start': {
      const delivery = next.deliveries.find(d => d.id === command.deliveryId);
      const driver = next.drivers.find(d => d.id === command.driverId);
      if (!delivery || !driver || delivery.driverId !== driver.id || delivery.status !== 'pending') return reject('Esta entrega não está disponível para este entregador.');
      if (!active(driver.id)) return reject('O usuário deste entregador está desativado.');
      if (driver.status === 'offline') return reject('Inicie seu turno antes de sair para a entrega.');
      if (next.deliveries.some(d => d.driverId === driver.id && d.status === 'in_transit')) return reject('Conclua a rota atual antes de iniciar outra.');
      delivery.status = 'in_transit'; driver.status = 'on_route';
      next.trips.push({ id: crypto.randomUUID(), driverId: driver.id, deliveryId: delivery.id, startedAt: now, date: next.demoDate, progress: 0, km: 0, distanceSource: simulation ? 'simulation' : 'gps', ...(!simulation ? { distanceMeters: 0 } : {}) });
      message = simulation ? 'Rota demonstrativa iniciada. Avance a simulação para percorrer o trajeto.' : 'Entrega iniciada. Ative o GPS durante o turno para registrar a distância.';
      break;
    }
    case 'advance': {
      if (!simulation) return reject('O avanço simulado não está disponível na operação por GPS.');
      const delivery = next.deliveries.find(d => d.id === command.deliveryId);
      const trip = next.trips.find(t => t.deliveryId === command.deliveryId && !t.finishedAt);
      if (!delivery || delivery.status !== 'in_transit' || !trip) return reject('Inicie uma rota para simular o percurso.');
      if (!active(trip.driverId)) return reject('O usuário deste entregador está desativado.');
      if (trip.progress === 1) return reject('Você chegou. Confirme o recebimento para finalizar.');
      const driver = next.drivers.find(d => d.id === trip.driverId)!;
      const remaining = 1 - trip.progress;
      trip.progress = Math.min(1, trip.progress + .25);
      trip.km = Math.round(delivery.estimatedKm * trip.progress * 100) / 100;
      const ratio = .25 / remaining;
      driver.position = { x: driver.position.x + (delivery.position.x - driver.position.x) * Math.min(1, ratio), y: driver.position.y + (delivery.position.y - driver.position.y) * Math.min(1, ratio) };
      message = trip.progress === 1 ? 'Destino alcançado na simulação. Confirme a entrega.' : 'Simulação avançada. Distância demonstrativa atualizada.';
      break;
    }
    case 'complete': {
      const delivery = next.deliveries.find(d => d.id === command.deliveryId);
      const trip = next.trips.find(t => t.deliveryId === command.deliveryId && !t.finishedAt);
      if (!delivery || delivery.status !== 'in_transit' || !trip) return reject('Esta entrega não possui uma rota em andamento.');
      if (!active(trip.driverId)) return reject('O usuário deste entregador está desativado.');
      if (simulation && trip.progress !== 1) return reject('Complete o percurso demonstrativo antes de confirmar a entrega.');
      const receivedBy = command.receivedBy.trim();
      if (!receivedBy || receivedBy.length > 120) return reject('Informe o nome de quem recebeu, com até 120 caracteres.');
      delivery.status = 'delivered'; delivery.deliveredAt = now; delivery.receivedBy = receivedBy; trip.finishedAt = now; trip.progress = 1;
      next.drivers.find(d => d.id === trip.driverId)!.status = 'available';
      message = 'Entrega confirmada. Bom trabalho!';
      break;
    }
    case 'availability': {
      const driver = next.drivers.find(d => d.id === command.driverId);
      if (!driver) return reject('Entregador não encontrado.');
      if (!active(driver.id)) return reject('O usuário deste entregador está desativado.');
      if (next.deliveries.some(d => d.driverId === driver.id && d.status === 'in_transit')) return reject('Conclua a entrega em andamento antes de encerrar o turno.');
      if (command.online && driver.status !== 'offline') return reject('Seu turno já está em andamento.');
      driver.status = command.online ? 'available' : 'offline';
      driver.shiftStartedAt = command.online ? now : null;
      message = command.online ? 'Turno iniciado.' : 'Turno encerrado.';
      break;
    }
    case 'save-user': {
      const user = { ...command.user, name: command.user.name.trim(), email: command.user.email.trim().toLowerCase() };
      if (!user.id || !user.name || user.name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) || !['admin', 'manager', 'driver'].includes(user.role)) return reject('Revise o nome, o e-mail e a função do usuário.');
      if (next.users.some(u => u.email === user.email && u.id !== user.id)) return reject('Este e-mail já está cadastrado.');
      if (user.role === 'driver' && user.driverId && (!next.drivers.some(d => d.id === user.driverId) || next.users.some(u => u.id !== user.id && u.driverId === user.driverId))) return reject('Este entregador já está vinculado a outro usuário.');
      if (user.role !== 'driver') delete user.driverId;
      const previous = next.users.find(u => u.id === user.id);
      if (previous?.role === 'admin' && previous.active && (user.role !== 'admin' || !user.active) && next.users.filter(u => u.role === 'admin' && u.active).length === 1) return reject('Mantenha pelo menos um administrador ativo.');
      if (previous?.driverId && (previous.driverId !== user.driverId || !user.active) && next.deliveries.some(d => d.driverId === previous.driverId && d.status === 'in_transit')) return reject('Conclua a rota deste entregador antes de alterar o vínculo ou desativar o usuário.');
      if (user.role === 'driver' && !user.driverId) {
        const id = crypto.randomUUID();
        const words = user.name.split(/\s+/);
        next.drivers.push({ id, name: user.name, initials: (words[0][0] + (words.length > 1 ? words.at(-1)![0] : '')).toUpperCase(), color: '#4e806f', phone: 'Não informado', vehicle: 'Veículo não informado', status: 'offline', position: { x: 45, y: 50 }, kmToday: 0, shiftStartedAt: null });
        user.driverId = id;
      }
      if (previous?.driverId && (previous.driverId !== user.driverId || !user.active)) {
        const previousDriver = next.drivers.find(d => d.id === previous.driverId);
        if (previousDriver) { previousDriver.status = 'offline'; previousDriver.shiftStartedAt = null; }
      }
      const index = next.users.findIndex(u => u.id === user.id);
      if (index >= 0) next.users[index] = user; else next.users.push(user);
      if (user.role === 'driver' && user.driverId) {
        const driver = next.drivers.find(d => d.id === user.driverId)!;
        const words = user.name.split(/\s+/);
        driver.name = user.name;
        driver.initials = (words[0][0] + (words.length > 1 ? words.at(-1)![0] : '')).toUpperCase();
      }
      message = index >= 0 ? 'Usuário atualizado.' : 'Usuário adicionado à demonstração.';
      break;
    }
    case 'toggle-user': {
      const user = next.users.find(u => u.id === command.id);
      if (!user) return reject('Usuário não encontrado.');
      if (user.active && user.role === 'admin' && next.users.filter(u => u.active && u.role === 'admin').length === 1) return reject('Mantenha pelo menos um administrador ativo.');
      if (user.active && user.driverId && next.deliveries.some(d => d.driverId === user.driverId && d.status === 'in_transit')) return reject('Conclua a rota deste entregador antes de desativar o usuário.');
      user.active = !user.active;
      if (!user.active && user.driverId) {
        const driver = next.drivers.find(d => d.id === user.driverId)!;
        driver.status = 'offline'; driver.shiftStartedAt = null;
      }
      message = user.active ? 'Usuário ativado.' : 'Usuário desativado.';
      break;
    }
  }
  return { state: deriveState(next), message };
}
