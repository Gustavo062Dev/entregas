export type DeliveryStatus = 'pending' | 'in_transit' | 'delivered';
export type DriverStatus = 'available' | 'on_route' | 'offline';
export type Section = 'overview' | 'deliveries' | 'reports' | 'users';
export interface Position { x: number; y: number }
export interface Driver {
  id: string;
  name: string;
  initials: string;
  color: string;
  phone: string;
  vehicle: string;
  status: DriverStatus;
  position: Position;
  kmToday: number;
  shiftStartedAt: string | null;
}
export interface Delivery {
  id: string;
  code: string;
  customer: string;
  address: string;
  neighborhood: string;
  phone: string;
  driverId: string | null;
  status: DeliveryStatus;
  window: string;
  estimatedKm: number;
  position: Position;
  note: string;
  deliveredAt?: string;
  receivedBy?: string;
}
export interface Trip {
  id: string;
  driverId: string;
  deliveryId: string;
  startedAt: string;
  finishedAt?: string;
  date: string;
  km: number;
  progress: number;
}
export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'manager' | 'driver';
  active: boolean;
  driverId?: string;
}
export interface AppState {
  version: 1;
  demoDate: string;
  drivers: Driver[];
  deliveries: Delivery[];
  trips: Trip[];
  users: AppUser[];
}
export interface AppActions {
  assignDelivery: (deliveryId: string, driverId: string | null) => boolean | Promise<boolean>;
  startRoute: (deliveryId: string, driverId: string) => boolean | Promise<boolean>;
  advanceRoute: (deliveryId: string) => boolean | Promise<boolean>;
  completeDelivery: (deliveryId: string, receivedBy: string) => boolean | Promise<boolean>;
  setDriverAvailability: (driverId: string, online: boolean) => boolean | Promise<boolean>;
  saveUser: (user: AppUser, password?: string) => boolean | Promise<boolean>;
  toggleUser: (id: string) => boolean | Promise<boolean>;
  resetDemo: () => boolean | Promise<boolean>;
  notify: (message: string) => void;
}
export interface ConnectedAccess {
  user: AppUser;
  signOut: () => void | Promise<void>;
  syncing: boolean;
  error: string;
  refresh: () => void | Promise<void>;
  simulation: boolean;
}
export interface ScreenProps { state: AppState; actions: AppActions; access?: ConnectedAccess }
export const deliveryStatusLabel: Record<DeliveryStatus, string> = {
  pending: 'Pendente', in_transit: 'Em rota', delivered: 'Entregue',
};
export const driverStatusLabel: Record<DriverStatus, string> = {
  available: 'Disponível', on_route: 'Em rota', offline: 'Offline',
};
export function formatKm(value: number) {
  return value.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
