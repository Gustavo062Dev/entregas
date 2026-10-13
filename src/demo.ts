import type { AppState, Delivery, Driver, Trip } from './types';

export function localDay(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}-${parts.find(p => p.type === 'day')!.value}`;
}

export function createDemoState(today = localDay()): AppState {
  const drivers: Driver[] = [
    { id: 'd1', name: 'Rafael Costa', initials: 'RC', color: '#4e806f', phone: '(11) 90000-0001', vehicle: 'Moto · DEM-0001', status: 'available', position: { x: 37, y: 60 }, kmToday: 0, shiftStartedAt: `${today}T08:00:00-03:00` },
    { id: 'd2', name: 'Camila Santos', initials: 'CS', color: '#8a71c6', phone: '(11) 90000-0002', vehicle: 'Moto · DEM-0002', status: 'on_route', position: { x: 60, y: 41 }, kmToday: 0, shiftStartedAt: `${today}T08:15:00-03:00` },
    { id: 'd3', name: 'Lucas Almeida', initials: 'LA', color: '#4c83ba', phone: '(11) 90000-0003', vehicle: 'Carro · DEM-0003', status: 'available', position: { x: 76, y: 66 }, kmToday: 0, shiftStartedAt: `${today}T08:30:00-03:00` },
    { id: 'd4', name: 'Beatriz Lima', initials: 'BL', color: '#d29054', phone: '(11) 90000-0004', vehicle: 'Moto · DEM-0004', status: 'offline', position: { x: 25, y: 31 }, kmToday: 0, shiftStartedAt: null },
  ];
  const specs: Array<[string, string, string, string | null, Delivery['status'], number, number, number]> = [
    ['Mariana Oliveira', 'Rua dos Pinheiros, 870', 'Pinheiros', 'd1', 'pending', 3.8, 28, 48],
    ['Bruno Ferreira', 'Rua Harmonia, 540', 'Vila Madalena', 'd2', 'in_transit', 5.2, 43, 27],
    ['Juliana Ribeiro', 'Alameda Santos, 1220', 'Jardim Paulista', 'd3', 'pending', 2.6, 66, 64],
    ['Felipe Souza', 'Rua Augusta, 1500', 'Consolação', 'd1', 'pending', 4.1, 62, 46],
    ['Carolina Mendes', 'Rua Itapeva, 300', 'Bela Vista', null, 'pending', 3.3, 77, 48],
    ['Pedro Martins', 'Rua Oscar Freire, 900', 'Jardins', 'd2', 'pending', 2.4, 51, 64],
    ['Ana Rodrigues', 'Rua Fidalga, 210', 'Vila Madalena', 'd1', 'delivered', 4.8, 38, 32],
    ['Gustavo Azevedo', 'Rua da Consolação, 2100', 'Consolação', 'd2', 'delivered', 6.2, 67, 38],
    ['Isabela Rocha', 'Av. Brigadeiro Luís Antônio, 1700', 'Bela Vista', 'd3', 'delivered', 3.6, 78, 59],
    ['Diego Carvalho', 'Rua Teodoro Sampaio, 1300', 'Pinheiros', 'd1', 'delivered', 2.7, 35, 52],
    ['Lívia Fernandes', 'Rua Haddock Lobo, 600', 'Jardins', 'd3', 'delivered', 5.1, 59, 58],
    ['Renato Barros', 'Rua Fradique Coutinho, 400', 'Pinheiros', 'd2', 'delivered', 3.4, 28, 58],
  ];
  const deliveries: Delivery[] = specs.map(([customer, address, neighborhood, driverId, status, estimatedKm, x, y], i) => ({
    id: `e${i + 1}`, code: `RT-${String(1041 + i)}`, customer, address: `${address}, São Paulo – SP`, neighborhood,
    phone: `(11) 90000-${String(1000 + i)}`, driverId, status, estimatedKm, position: { x, y },
    window: i % 2 ? '14:00 – 16:00' : '13:00 – 15:00',
    note: i === 0 ? 'Deixar na portaria e confirmar o nome do recebedor.' : i === 2 ? 'Interfone 42. Entrega na recepção.' : '',
    ...(status === 'delivered' ? { deliveredAt: `${today}T${String(9 + i % 3).padStart(2, '0')}:30:00-03:00`, receivedBy: customer.split(' ')[0] } : {}),
  }));
  const trips: Trip[] = deliveries.filter(d => d.status === 'delivered').map((d, i) => ({ id: `t${i}`, deliveryId: d.id, driverId: d.driverId!, date: today, km: d.estimatedKm, progress: 1, startedAt: `${today}T09:00:00-03:00`, finishedAt: d.deliveredAt }));
  trips.push({ id: 't-current', driverId: 'd2', deliveryId: 'e2', date: today, km: 1.3, progress: .25, startedAt: `${today}T12:45:00-03:00` });
  for (let n = 1; n <= 4; n++) {
    const date = new Date(`${today}T12:00:00-03:00`);
    date.setUTCDate(date.getUTCDate() - n);
    const day = date.toISOString().slice(0, 10);
    for (let i = 0; i < 3; i++) trips.push({ id: `history-${n}-${i}`, driverId: `d${i + 1}`, deliveryId: `demo-history-${n}-${i}`, date: day, km: 8.4 + n * 1.2 + i * 2.6, progress: 1, startedAt: `${day}T09:00:00-03:00`, finishedAt: `${day}T10:00:00-03:00` });
  }
  return deriveState({ version: 1, demoDate: today, drivers, deliveries, trips, users: [
    { id: 'u1', name: 'Gustavo Oliveira', email: 'gestor@example.com', role: 'admin', active: true },
    { id: 'u2', name: 'Fernanda Alves', email: 'operacao@example.com', role: 'manager', active: true },
    ...drivers.map((d, i) => ({ id: `u${i + 3}`, name: d.name, email: `entregador${i + 1}@example.com`, role: 'driver' as const, active: true, driverId: d.id })),
  ] });
}

export function deriveState(state: AppState): AppState {
  return { ...state, drivers: state.drivers.map(driver => ({ ...driver, kmToday: Math.round(state.trips.filter(t => t.driverId === driver.id && t.date === state.demoDate).reduce((sum, t) => sum + t.km, 0) * 100) / 100 })) };
}
