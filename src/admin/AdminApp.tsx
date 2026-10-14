import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, CalendarDays, Check, CheckCircle2,
  ChevronRight, CircleHelp, ClipboardList, Clock3, FileBarChart2, Gauge,
  LayoutDashboard, LogOut, Mail, MapPin, Menu, MoreHorizontal, Navigation, Package,
  Plus, RefreshCw, Route, Search, ShieldCheck, Smartphone, Truck, Users, X,
} from 'lucide-react';
import MapCanvas from '../components/MapCanvas';
import GpsMap, { gpsAgeLabel, gpsIsStale, validGps } from '../components/GpsMap';
import { screenHref } from '../navigation';
import {
  deliveryStatusLabel, driverStatusLabel, formatKm,
  type AppUser, type Delivery, type Driver, type ScreenProps, type Section,
} from '../types';
import './admin.css';

const navigation: { id: Section; label: string; icon: typeof Route }[] = [
  { id: 'overview', label: 'Visão geral', icon: LayoutDashboard },
  { id: 'deliveries', label: 'Entregas', icon: Package },
  { id: 'reports', label: 'Relatórios', icon: FileBarChart2 },
  { id: 'users', label: 'Usuários', icon: Users },
];
const roleLabels: Record<AppUser['role'], string> = { admin: 'Administrador', manager: 'Gestor', driver: 'Entregador' };
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
const dateLabel = (date: string, options?: Intl.DateTimeFormatOptions) => {
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString('pt-BR', options || { day: '2-digit', month: 'short', year: 'numeric' });
};
const csvCell = (value: unknown) => {
  let content = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(content)) content = `'${content}`;
  return `"${content.replace(/"/g, '""')}"`;
};

function StatusBadge({ status }: { status: Delivery['status'] }) {
  return <span className={`admin-status admin-status-${status}`}><span />{deliveryStatusLabel[status]}</span>;
}

function Avatar({ name, color, small = false }: { name: string; color?: string; small?: boolean }) {
  return <span className={`admin-avatar${small ? ' admin-avatar-small' : ''}`} style={color ? { backgroundColor: `${color}20`, color } : undefined}>{initials(name)}</span>;
}

function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="admin-empty"><div className="admin-empty-icon"><Search size={23} /></div><strong>{title}</strong><p>{detail}</p>{action}</div>;
}

function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = dialogRef.current;
    const getFocusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]') || []);
    getFocusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const elements = getFocusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', onKeyDown); previous?.focus(); };
  }, [onClose]);
  return <div className="admin-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} className={`admin-modal${wide ? ' admin-modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="admin-modal-title">
      <div className="admin-modal-header"><div><span className="admin-eyebrow">ROTA · PAINEL ADMINISTRATIVO</span><h2 id="admin-modal-title">{title}</h2></div><button className="admin-icon-button" aria-label="Fechar janela" onClick={onClose}><X size={21} /></button></div>
      {children}
    </div>
  </div>;
}

export default function AdminApp({ state, actions, access }: ScreenProps) {
  const canManageUsers = !access || access.user.role === 'admin';
  const mutationsBlocked = Boolean(access?.syncing || access?.error);
  const simulated = access?.simulation ?? true;
  const realGps = Boolean(access && !simulated);
  const [section, setSection] = useState<Section>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [driverFilter, setDriverFilter] = useState('all');
  const [reportFrom, setReportFrom] = useState(state.demoDate);
  const [reportTo, setReportTo] = useState(state.demoDate);
  const [reportDriver, setReportDriver] = useState('all');
  const [userSearch, setUserSearch] = useState('');
  const [userForm, setUserForm] = useState<AppUser | null>(null);
  const [userPassword, setUserPassword] = useState('');
  const [userSaving, setUserSaving] = useState(false);
  const userSavePending = useRef(false);
  const [formError, setFormError] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const closeUserModal = useMemo(() => () => {
    if (userSavePending.current) return;
    setUserForm(null);
    setUserPassword('');
    setFormError('');
  }, []);
  const closeDetailModal = useMemo(() => () => setDetailId(null), []);
  const closeInfoModal = useMemo(() => () => setShowInfo(false), []);
  const driversById = new Map(state.drivers.map(driver => [driver.id, driver]));
  const selectedDriver = state.drivers.find(driver => driver.id === selectedDriverId);
  const pendingCount = state.deliveries.filter(delivery => delivery.status === 'pending').length;
  const inTransitCount = state.deliveries.filter(delivery => delivery.status === 'in_transit').length;
  const deliveredCount = state.deliveries.filter(delivery => delivery.status === 'delivered').length;
  const activeDrivers = state.drivers.filter(driver => driver.status !== 'offline').length;
  const kmToday = state.drivers.reduce((sum, driver) => sum + driver.kmToday, 0);
  const hasSimulationToday = realGps && state.trips.some(trip => trip.date === state.demoDate && trip.distanceSource !== 'gps' && trip.km > 0);
  const completionRate = state.deliveries.length ? Math.round(deliveredCount / state.deliveries.length * 100) : 0;
  const deliveries = state.deliveries.filter(delivery => {
    const query = search.trim().toLocaleLowerCase('pt-BR');
    return (!query || `${delivery.code} ${delivery.customer} ${delivery.address} ${delivery.neighborhood}`.toLocaleLowerCase('pt-BR').includes(query))
      && (statusFilter === 'all' || delivery.status === statusFilter)
      && (driverFilter === 'all' || (driverFilter === 'unassigned' ? !delivery.driverId : delivery.driverId === driverFilter));
  });
  const reportDateInvalid = Boolean(reportFrom && reportTo && reportFrom > reportTo);
  const reportTrips = reportDateInvalid ? [] : state.trips.filter(trip => (!reportFrom || trip.date >= reportFrom) && (!reportTo || trip.date <= reportTo) && (reportDriver === 'all' || trip.driverId === reportDriver));
  const reportGpsDays = !realGps || reportDateInvalid ? [] : (state.gpsDays ?? []).filter(day => (!reportFrom || day.date >= reportFrom) && (!reportTo || day.date <= reportTo) && (reportDriver === 'all' || day.driverId === reportDriver));
  const reportLegacyTrips = realGps ? reportTrips.filter(trip => trip.distanceSource !== 'gps') : reportTrips;
  const reportKm = reportGpsDays.reduce((sum, day) => sum + day.meters / 1000, 0) + reportLegacyTrips.reduce((sum, trip) => sum + trip.km, 0);
  const hasReportData = reportGpsDays.length > 0 || reportLegacyTrips.length > 0;
  const gpsGaps = reportGpsDays.reduce((sum, day) => sum + day.gaps, 0);
  const completedTrips = reportTrips.filter(trip => trip.finishedAt);
  const reportRows = state.drivers.filter(driver => reportDriver === 'all' || driver.id === reportDriver).map(driver => {
    const trips = reportTrips.filter(trip => trip.driverId === driver.id);
    const gpsDays = reportGpsDays.filter(day => day.driverId === driver.id);
    const legacyTrips = reportLegacyTrips.filter(trip => trip.driverId === driver.id);
    return { driver, trips, gpsDays, km: gpsDays.reduce((sum, day) => sum + day.meters / 1000, 0) + legacyTrips.reduce((sum, trip) => sum + trip.km, 0), completed: trips.filter(trip => trip.finishedAt).length };
  }).filter(row => row.trips.length > 0 || row.gpsDays.length > 0);
  const filteredUsers = state.users.filter(user => `${user.name} ${user.email} ${roleLabels[user.role]}`.toLocaleLowerCase('pt-BR').includes(userSearch.trim().toLocaleLowerCase('pt-BR')));
  const detailDelivery = state.deliveries.find(delivery => delivery.id === detailId);
  const currentAdmin = access?.user || state.users.find(user => user.role === 'admin' && user.active);
  const selectSection = (next: Section) => { setSection(next === 'users' && !canManageUsers ? 'overview' : next); setMobileMenuOpen(false); };
  useEffect(() => {
    if (!canManageUsers) {
      setSection(previous => previous === 'users' ? 'overview' : previous);
      setUserForm(null);
      setUserPassword('');
      setFormError('');
    }
  }, [canManageUsers]);

  const exportReport = () => {
    if (!hasReportData) { actions.notify('Não há registros de distância no período selecionado para exportar.'); return; }
    const rows = realGps ? [
      ['Data', 'Entregador', 'Pedido / registro', 'Início', 'Fim', realGps ? 'Quilômetros' : 'Quilômetros simulados', 'Status', 'Origem de distância', 'Interrupções de GPS'],
      ...reportGpsDays.map(day => [day.date, driversById.get(day.driverId)?.name || day.driverId, 'Total do turno no dia', '', '', (day.meters / 1000).toFixed(2).replace('.', ','), `${day.acceptedPoints} posições aceitas`, 'GPS', day.gaps]),
      ...reportLegacyTrips.map(trip => [trip.date, driversById.get(trip.driverId)?.name || trip.driverId, state.deliveries.find(delivery => delivery.id === trip.deliveryId)?.code || trip.deliveryId, trip.startedAt, trip.finishedAt || '', trip.km.toFixed(2).replace('.', ','), trip.finishedAt ? 'Concluído' : 'Em andamento', 'Simulação', '']),
    ] : [
      ['Data', 'Entregador', 'Pedido', 'Início', 'Fim', 'Quilômetros simulados', 'Status'],
      ...reportTrips.map(trip => [trip.date, driversById.get(trip.driverId)?.name || trip.driverId, state.deliveries.find(delivery => delivery.id === trip.deliveryId)?.code || trip.deliveryId, trip.startedAt, trip.finishedAt || '', trip.km.toFixed(2).replace('.', ','), trip.finishedAt ? 'Concluído' : 'Em andamento']),
    ];
    const blob = new Blob(['\uFEFF' + rows.map(row => row.map(csvCell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `rota-quilometragem${realGps ? '' : '-simulada'}-${reportFrom || 'inicio'}-${reportTo || 'fim'}.csv`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    actions.notify(realGps ? 'Relatório de distância exportado com a origem de cada registro.' : 'Relatório de quilômetros simulados exportado.');
  };

  const saveUser = async (event: FormEvent) => {
    event.preventDefault();
    if (!userForm || !canManageUsers || mutationsBlocked || userSavePending.current) return;
    const name = userForm.name.trim();
    const email = userForm.email.trim().toLowerCase();
    if (name.length < 2) { setFormError('Informe um nome com pelo menos 2 caracteres.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setFormError('Informe um e-mail válido.'); return; }
    if (state.users.some(user => user.id !== userForm.id && user.email.toLowerCase() === email)) { setFormError('Este e-mail já está cadastrado.'); return; }
    if (userForm.role === 'driver' && userForm.driverId && !state.drivers.some(driver => driver.id === userForm.driverId)) { setFormError('O entregador selecionado não foi encontrado. Selecione outro vínculo.'); return; }
    if (access && ((!userForm.id && userPassword.length < 12) || (userPassword && userPassword.length < 12))) { setFormError('A senha deve ter pelo menos 12 caracteres.'); return; }
    userSavePending.current = true;
    setUserSaving(true);
    setFormError('');
    try {
      const saved = await actions.saveUser({ ...userForm, id: userForm.id || `user-${crypto.randomUUID()}`, name, email, driverId: userForm.role === 'driver' ? userForm.driverId || undefined : undefined }, access && userPassword ? userPassword : undefined);
      if (saved) { setUserForm(null); setUserPassword(''); }
      else setFormError('Não foi possível salvar o usuário. Confira os dados e tente novamente.');
    } catch {
      setFormError('Não foi possível salvar o usuário. Tente novamente quando a conexão estiver disponível.');
    } finally {
      userSavePending.current = false;
      setUserSaving(false);
    }
  };

  const openUser = (user?: AppUser) => {
    if (!canManageUsers || mutationsBlocked || userSavePending.current) return;
    setFormError('');
    setUserPassword('');
    setUserForm(user ? { ...user } : { id: '', name: '', email: '', role: 'manager', active: true });
  };

  const deliveryTable = (items: Delivery[], canAssign = false) => <div className="admin-table-scroll"><table className="admin-table admin-delivery-table">
    <thead><tr><th>Pedido / cliente</th><th>Destino</th><th>Entregador</th><th>Status</th><th>Janela de entrega</th><th><span className="admin-sr-only">Detalhes</span></th></tr></thead>
    <tbody>{items.map(delivery => {
      const driver = delivery.driverId ? driversById.get(delivery.driverId) : undefined;
      return <tr key={delivery.id}>
        <td><div className="admin-order-cell"><span className="admin-package-icon"><Package size={18} /></span><div><strong>{delivery.code}</strong><span>{delivery.customer}</span></div></div></td>
        <td><div className="admin-destination"><strong>{delivery.neighborhood}</strong><span title={delivery.address}>{delivery.address}</span></div></td>
        <td>{canAssign && delivery.status === 'pending' ? <select className="admin-assignment-select" disabled={mutationsBlocked} aria-label={`Entregador do pedido ${delivery.code}`} value={delivery.driverId || ''} onChange={event => { if (!mutationsBlocked) void actions.assignDelivery(delivery.id, event.target.value || null); }}><option value="">Atribuir entregador</option>{state.drivers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select> : driver ? <div className="admin-table-driver"><Avatar name={driver.name} color={driver.color} small /><span>{driver.name}</span></div> : <span className="admin-muted">Aguardando atribuição</span>}</td>
        <td><StatusBadge status={delivery.status} /></td>
        <td><span className="admin-window"><Clock3 size={14} />{delivery.window}</span></td>
        <td><button className="admin-icon-button" onClick={() => setDetailId(delivery.id)} aria-label={`Ver detalhes do pedido ${delivery.code}`}><ChevronRight size={19} /></button></td>
      </tr>;
    })}</tbody>
  </table></div>;

  return <div className="admin-shell">
    {mobileMenuOpen && <button className="admin-sidebar-scrim" onClick={() => setMobileMenuOpen(false)} aria-label="Fechar menu" />}
    <aside className={`admin-sidebar${mobileMenuOpen ? ' is-open' : ''}`}>
      <a className="admin-brand" href={screenHref('admin')} aria-label="Rota, painel administrativo"><span className="admin-brand-mark"><Route size={28} strokeWidth={2.4} /></span><span>rota<span className="admin-brand-dot">.</span></span></a>
      <div className="admin-workspace"><span className="admin-workspace-icon"><Truck size={18} /></span><div><strong>Central de entregas</strong><span>Seu espaço de trabalho</span></div><span className="admin-workspace-dot" /></div>
      <span className="admin-nav-label">PRINCIPAL</span>
      <nav aria-label="Navegação administrativa">{navigation.filter(item => item.id !== 'users' || canManageUsers).map(item => <button key={item.id} className={`admin-nav-item${section === item.id ? ' active' : ''}`} aria-current={section === item.id ? 'page' : undefined} onClick={() => selectSection(item.id)}><item.icon size={19} /><span>{item.label}</span>{item.id === 'deliveries' && pendingCount > 0 && <span className="admin-nav-count">{pendingCount}</span>}{section === item.id && <span className="admin-nav-active-dot" />}</button>)}</nav>
      <div className="admin-sidebar-bottom"><div className="admin-sidebar-card"><div className="admin-sidebar-card-icon"><Navigation size={22} /></div><strong>Seu time, conectado.</strong><p>Acompanhe a operação da central até a última entrega.</p><a href={screenHref('driver')} target="_blank" rel="noreferrer">Abrir app do entregador<ArrowUpRight size={15} /></a></div><button className="admin-help-button" onClick={() => setShowInfo(true)}><CircleHelp size={18} />{access ? 'Sobre a operação' : 'Sobre a demonstração'}<ArrowUpRight size={14} /></button><div className="admin-sidebar-version"><span className="admin-sidebar-mini-logo"><Route size={14} /></span>Feito para ir mais longe.<span>v0.1</span></div></div>
    </aside>

    <div className="admin-main-wrap">
      <header className={`admin-topbar${access ? ' admin-topbar-connected' : ''}`}><div className="admin-topbar-left"><button className="admin-icon-button admin-mobile-menu" onClick={() => setMobileMenuOpen(true)} aria-label="Abrir menu"><Menu size={22} /></button><span className="admin-breadcrumb">Painel administrativo<ChevronRight size={13} /><strong>{navigation.find(item => item.id === section)?.label}</strong></span></div><div className="admin-topbar-actions"><span className={`admin-demo-badge${access ? ' admin-connected-badge' : ''}`}><span />{access ? access.error ? 'Sem sincronização' : access.syncing ? 'Sincronizando' : 'Conectado' : 'Demonstração'}</span><a className="admin-app-link" href={screenHref('driver')} target="_blank" rel="noreferrer"><Smartphone size={16} /><span>App do entregador</span><ArrowUpRight size={14} /></a><div className="admin-profile" title={access ? `${currentAdmin?.name} · ${roleLabels[access.user.role]}` : 'Sessão de demonstração'}><Avatar name={currentAdmin?.name || 'Administrador'} small /><div><strong>{currentAdmin?.name.split(' ')[0] || 'Administrador'}</strong><span>{access ? roleLabels[access.user.role] : 'Sessão de demonstração'}</span></div></div>{access && <button className="admin-signout-button" onClick={() => void access.signOut()}><LogOut size={15} />Sair</button>}</div></header>

      <main className="admin-content">
        {access && <div className={`admin-connection-banner${access.error ? ' has-error' : ''}`} role={access.error ? 'alert' : 'status'}><ShieldCheck size={19} /><div><strong>{access.error ? 'Sincronização interrompida' : access.syncing ? 'Sincronizando a operação…' : 'Cadastros compartilhados'}</strong><p>{access.error || `Acesso de ${roleLabels[access.user.role].toLocaleLowerCase('pt-BR')}. ${realGps ? 'Localizações e quilômetros recebidos do GPS no Android.' : 'Mapa e quilômetros simulados; o rastreamento por GPS está disponível na operação real.'}`}</p></div>{access.error && <button className="admin-button admin-button-light" disabled={access.syncing} onClick={() => void access.refresh()}><RefreshCw size={15} />Tentar novamente</button>}</div>}
        <div className="admin-page-heading"><div><div className="admin-eyebrow"><span className="admin-eyebrow-line" />{section === 'overview' ? 'SUA OPERAÇÃO, EM MOVIMENTO' : section === 'deliveries' ? 'DA CENTRAL AO DESTINO' : section === 'reports' ? 'DADOS QUE MOSTRAM O CAMINHO' : 'AS PESSOAS POR TRÁS DAS ENTREGAS'}</div><h1>{section === 'overview' ? <>Cada entrega,<br className="admin-mobile-break" /> no caminho certo<span>.</span></> : section === 'deliveries' ? <>Gestão de entregas<span>.</span></> : section === 'reports' ? <>Quilômetros e resultados<span>.</span></> : <>Um time, vários caminhos<span>.</span></>}</h1><p>{section === 'overview' ? 'Uma visão completa do seu time e de tudo que está na rua.' : section === 'deliveries' ? 'Organize os pedidos, distribua as entregas e acompanhe cada etapa.' : section === 'reports' ? 'Acompanhe a distância percorrida e a produtividade de cada entregador.' : 'Gerencie os cadastros e os perfis da sua operação.'}</p></div><div className="admin-heading-actions">{section === 'users' && canManageUsers ? <button className="admin-button admin-button-dark" disabled={mutationsBlocked || userSaving} onClick={() => openUser()}><Plus size={17} />Novo usuário</button> : section === 'reports' ? <button className="admin-button admin-button-dark" disabled={!hasReportData || reportDateInvalid} onClick={exportReport}><ArrowDownToLine size={17} />Exportar CSV</button> : <div className="admin-date-label"><CalendarDays size={17} /><span>{dateLabel(state.demoDate, { day: '2-digit', month: 'long', year: 'numeric' })}</span></div>}</div></div>

        {section === 'overview' && <>
          <div className="admin-stats-grid">
            <MetricCard icon={<Package size={21} />} title="Entregas na operação" value={state.deliveries.length} detail={`${deliveredCount} concluídas · ${pendingCount} pendentes`} accent="purple" />
            <MetricCard icon={<Navigation size={21} />} title="Entregas em rota" value={inTransitCount} detail={`${activeDrivers} de ${state.drivers.length} entregadores online`} accent="lime" active />
            <MetricCard icon={<Route size={21} />} title="Quilômetros hoje" value={<>{formatKm(kmToday)}<small>km</small></>} detail={realGps ? hasSimulationToday ? 'GPS + registros simulados antigos' : 'Distância GPS registrada no turno' : 'Distância simulada na demonstração'} accent="blue" />
            <MetricCard icon={<CheckCircle2 size={21} />} title="Entregas concluídas" value={<>{completionRate}<small>%</small></>} detail={`${deliveredCount} de ${state.deliveries.length} entregas concluídas`} accent="orange" />
          </div>
          <div className="admin-operation-grid">
            <section className="admin-card admin-map-card" aria-labelledby="map-heading"><div className="admin-card-heading"><div><h2 id="map-heading"><span className="admin-heading-icon"><MapPin size={18} /></span>Operação no mapa</h2><p>{selectedDriver ? `Acompanhando ${selectedDriver.name}` : 'Cada entregador no seu caminho.'}</p></div><span className="admin-map-status"><span />{realGps ? 'Posições recebidas por GPS' : 'Localização simulada'}</span></div><div className="admin-map-area"><>{realGps ? <GpsMap drivers={state.drivers} selectedDriverId={selectedDriverId} onSelectDriver={setSelectedDriverId} /> : <MapCanvas drivers={state.drivers} deliveries={state.deliveries} selectedDriverId={selectedDriverId} onSelectDriver={setSelectedDriverId} />}</></div><div className="admin-map-footer"><div>{realGps ? <><span className="admin-legend-dot admin-legend-available" />Posição GPS<span className="admin-legend-dot admin-legend-offline" />Antiga: mais de 2 min</> : <><span className="admin-legend-dot admin-legend-route" />Em rota<span className="admin-legend-dot admin-legend-available" />Disponível<span className="admin-legend-dot admin-legend-offline" />Offline</>}</div><span><span className="admin-map-pulse" />{realGps ? 'Atualização a cada 5 s' : 'Demonstração interativa'}</span></div></section>
            <section className="admin-card admin-drivers-card" aria-labelledby="drivers-heading"><div className="admin-card-heading"><div><h2 id="drivers-heading">Seu time na rua<span className="admin-count-pill">{state.drivers.length}</span></h2><p>{activeDrivers} entregadores online agora</p></div><Users size={19} className="admin-subtle-icon" /></div><div className="admin-driver-list">{state.drivers.length ? state.drivers.map(driver => <DriverCard key={driver.id} realGps={realGps} driver={driver} selected={selectedDriverId === driver.id} deliveries={state.deliveries.filter(delivery => delivery.driverId === driver.id)} onClick={() => setSelectedDriverId(selectedDriverId === driver.id ? null : driver.id)} />) : <EmptyState title="Seu time aparece aqui" detail="Nenhum entregador cadastrado." />}</div><button className="admin-drivers-footer" onClick={() => selectSection(canManageUsers ? 'users' : 'overview')}>{canManageUsers ? 'Gerenciar equipe' : 'Visão da equipe'}<ArrowRight size={15} /></button></section>
          </div>
          <section className="admin-card admin-recent-card" aria-labelledby="recent-heading"><div className="admin-card-heading"><div><h2 id="recent-heading">Entregas da operação<span className="admin-count-pill">{state.deliveries.length}</span></h2><p>O próximo destino está logo ali.</p></div><button className="admin-text-button" onClick={() => selectSection('deliveries')}>Ver todas as entregas<ArrowRight size={16} /></button></div>{state.deliveries.length ? deliveryTable(state.deliveries.slice(0, 5)) : <EmptyState title="Ainda não há entregas" detail="Os pedidos da operação aparecerão aqui." />}<div className="admin-table-footer"><span>Mostrando {Math.min(5, state.deliveries.length)} de {state.deliveries.length} entregas</span><span><ShieldCheck size={14} />{access ? 'Pedidos compartilhados' : 'Dados de demonstração'}</span></div></section>
          <div className="admin-bottom-note"><span className="admin-bottom-note-icon"><Route size={16} /></span>Mais clareza na central. Mais fluidez na rua.<span>Rota · Gestão de entregas</span></div>
        </>}

        {section === 'deliveries' && <>
          <div className="admin-summary-strip"><div><span className="admin-summary-icon purple"><Package size={19} /></span><span><strong>{state.deliveries.length}</strong> entregas</span></div><div><span className="admin-status-dot pending" /><span><strong>{pendingCount}</strong> pendentes</span></div><div><span className="admin-status-dot in_transit" /><span><strong>{inTransitCount}</strong> em rota</span></div><div><span className="admin-status-dot delivered" /><span><strong>{deliveredCount}</strong> concluídas</span></div></div>
          <section className="admin-card"><div className="admin-filter-toolbar"><label className="admin-search-field"><Search size={18} /><span className="admin-sr-only">Buscar entregas</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar pedido, cliente ou endereço..." />{search && <button className="admin-search-clear" aria-label="Limpar busca" onClick={() => setSearch('')}><X size={15} /></button>}</label><label className="admin-filter-select"><span>Status</span><select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">Todos os status</option><option value="pending">Pendente</option><option value="in_transit">Em rota</option><option value="delivered">Entregue</option></select></label><label className="admin-filter-select"><span>Entregador</span><select value={driverFilter} onChange={event => setDriverFilter(event.target.value)}><option value="all">Todos os entregadores</option><option value="unassigned">Sem entregador</option>{state.drivers.map(driver => <option value={driver.id} key={driver.id}>{driver.name}</option>)}</select></label></div>{deliveries.length ? deliveryTable(deliveries, true) : <EmptyState title="Nenhuma entrega encontrada" detail="Tente outro nome ou ajuste os filtros para encontrar um pedido." action={<button className="admin-button admin-button-light" onClick={() => { setSearch(''); setStatusFilter('all'); setDriverFilter('all'); }}>Limpar filtros</button>} />}<div className="admin-table-footer"><span>{deliveries.length} de {state.deliveries.length} entregas</span><span>Atribua um entregador aos pedidos pendentes.</span></div></section>
          <div className="admin-info-note"><ClipboardList size={18} /><p>Pedidos e endereços demonstrativos. A integração com o Alpha7 será adicionada após a validação das telas.</p></div>
        </>}

        {section === 'reports' && <>
          <section className="admin-card admin-report-filters"><div className="admin-report-filter-intro"><CalendarDays size={21} /><div><strong>Defina o período</strong><span>Consulte os trajetos da sua equipe.</span></div></div><label className="admin-filter-select"><span>Data inicial</span><input type="date" value={reportFrom} onChange={event => setReportFrom(event.target.value)} /></label><label className="admin-filter-select"><span>Data final</span><input type="date" value={reportTo} onChange={event => setReportTo(event.target.value)} /></label><label className="admin-filter-select"><span>Entregador</span><select value={reportDriver} onChange={event => setReportDriver(event.target.value)}><option value="all">Toda a equipe</option>{state.drivers.map(driver => <option key={driver.id} value={driver.id}>{driver.name}</option>)}</select></label></section>
          {reportDateInvalid && <div className="admin-validation-error" role="alert">A data inicial deve ser anterior ou igual à data final.</div>}
          <div className="admin-stats-grid admin-report-stats"><MetricCard icon={<Route size={21} />} title="Distância percorrida" value={<>{formatKm(reportKm)}<small>km</small></>} detail={realGps ? 'GPS do turno + registros simulados antigos' : 'Quilômetros simulados no período'} accent="lime" active /><MetricCard icon={<CheckCircle2 size={21} />} title="Trajetos concluídos" value={completedTrips.length} detail={`${reportTrips.length} trajetos registrados no período`} accent="purple" /><MetricCard icon={<Gauge size={21} />} title={realGps ? 'Registros diários GPS' : 'Média por trajeto'} value={realGps ? reportGpsDays.length : <>{formatKm(reportTrips.length ? reportKm / reportTrips.length : 0)}<small>km</small></>} detail={realGps ? `${gpsGaps} interrupções de sinal no período` : 'Distância dividida por trajetos'} accent="blue" /></div>
          <section className="admin-card"><div className="admin-card-heading"><div><h2>Quilometragem por entregador</h2><p>Uma visão do movimento de cada pessoa do time.</p></div><span className="admin-simulation-label">{realGps ? 'GPS do turno' : 'Dados simulados'}</span></div>{reportRows.length ? <div className="admin-table-scroll"><table className="admin-table admin-reports-table"><thead><tr><th>Entregador</th><th>Trajetos</th><th>Concluídos</th><th>{realGps ? 'Distância registrada' : 'Distância simulada'}</th><th>Participação na distância</th></tr></thead><tbody>{reportRows.map(row => <tr key={row.driver.id}><td><div className="admin-table-driver"><Avatar name={row.driver.name} color={row.driver.color} /><div><strong>{row.driver.name}</strong><span>{row.driver.vehicle}</span></div></div></td><td>{row.trips.length}</td><td>{row.completed}</td><td className="admin-km-value">{formatKm(row.km)} <span>km</span></td><td><div className="admin-distance-share"><div><span style={{ width: `${reportKm ? row.km / reportKm * 100 : 0}%`, backgroundColor: row.driver.color }} /></div><span>{reportKm ? Math.round(row.km / reportKm * 100) : 0}%</span></div></td></tr>)}</tbody><tfoot><tr><td>Total da equipe</td><td>{reportTrips.length}</td><td>{completedTrips.length}</td><td>{formatKm(reportKm)} km</td><td /></tr></tfoot></table></div> : <EmptyState title="Nenhum trajeto no período" detail={realGps ? 'Escolha outro intervalo ou ative o GPS no aplicativo Android durante o turno.' : 'Escolha outro intervalo de datas ou simule uma rota no app do entregador.'} />}<div className="admin-table-footer"><span>{reportRows.length} entregadores no relatório</span><button className="admin-text-button" disabled={!hasReportData} onClick={exportReport}><ArrowDownToLine size={15} />Exportar dados completos</button></div></section>
          <div className="admin-info-note"><Gauge size={18} /><p>{access ? realGps ? `Distância estimada pelas posições aceitas do GPS, incluindo deslocamentos entre entregas. ${gpsGaps} interrupções no período: trechos sem sinal não são contabilizados. Os totais diários já incluem as entregas. Registros antigos de simulação aparecem separados no CSV. A medição não substitui um odômetro certificado.` : 'A quilometragem exibida nesta operação demonstrativa é simulada.' : 'As distâncias desta versão são simuladas. A medição por GPS e o histórico real serão conectados na etapa de integração.'}</p></div>
        </>}

        {section === 'users' && canManageUsers && <>
          <div className="admin-summary-strip"><div><span className="admin-summary-icon purple"><Users size={19} /></span><span><strong>{state.users.length}</strong> usuários cadastrados</span></div><div><span className="admin-status-dot delivered" /><span><strong>{state.users.filter(user => user.active).length}</strong> ativos</span></div><div><span className="admin-status-dot offline" /><span><strong>{state.users.filter(user => !user.active).length}</strong> inativos</span></div></div>
          <section className="admin-card"><div className="admin-filter-toolbar"><label className="admin-search-field admin-user-search"><Search size={18} /><span className="admin-sr-only">Buscar usuários</span><input value={userSearch} onChange={event => setUserSearch(event.target.value)} placeholder="Buscar por nome, e-mail ou perfil..." />{userSearch && <button className="admin-search-clear" aria-label="Limpar busca de usuários" onClick={() => setUserSearch('')}><X size={15} /></button>}</label><span className="admin-toolbar-label">Perfis da operação</span></div>{filteredUsers.length ? <div className="admin-table-scroll"><table className="admin-table admin-users-table"><thead><tr><th>Usuário</th><th>Perfil</th><th>Entregador vinculado</th><th>Status</th><th>Ações</th></tr></thead><tbody>{filteredUsers.map(user => <tr key={user.id}><td><div className="admin-table-driver"><Avatar name={user.name} /><div><strong>{user.name}</strong><span>{user.email}</span></div></div></td><td><span className={`admin-role admin-role-${user.role}`}>{roleLabels[user.role]}</span></td><td>{user.driverId ? driversById.get(user.driverId)?.name || 'Não encontrado' : <span className="admin-muted">—</span>}</td><td><button className={`admin-user-toggle${user.active ? ' is-active' : ''}`} role="switch" aria-checked={user.active} disabled={mutationsBlocked || userSaving} aria-label={`${user.active ? 'Desativar' : 'Ativar'} ${user.name}`} onClick={() => { if (canManageUsers && !mutationsBlocked) void actions.toggleUser(user.id); }}><span /><span className="admin-user-toggle-label">{user.active ? 'Ativo' : 'Inativo'}</span></button></td><td><button className="admin-button admin-button-compact" disabled={mutationsBlocked || userSaving} onClick={() => openUser(user)}>Editar<MoreHorizontal size={17} /></button></td></tr>)}</tbody></table></div> : <EmptyState title="Nenhum usuário encontrado" detail="Tente outro nome ou cadastre uma pessoa para o seu time." />}<div className="admin-table-footer"><span>{filteredUsers.length} de {state.users.length} usuários</span><span><ShieldCheck size={14} />{access ? 'Cadastros compartilhados' : 'Cadastros locais de demonstração'}</span></div></section><div className="admin-info-note"><ShieldCheck size={18} /><p>{access ? 'O administrador gerencia os usuários. Gestores acompanham a operação e entregadores acessam suas próprias entregas.' : 'Esta prévia usa cadastros locais. O login e as permissões estão disponíveis na aplicação conectada ao servidor.'}</p></div>
        </>}
      </main>
    </div>

    {userForm && canManageUsers && <Modal title={userForm.id ? 'Editar usuário' : 'Um novo caminho começa aqui.'} onClose={closeUserModal}>
      <form className="admin-user-form" onSubmit={saveUser} aria-busy={userSaving}>
        <p className="admin-form-intro">Preencha os dados de quem vai fazer parte da sua operação.</p>
        <fieldset className="admin-user-fields" disabled={mutationsBlocked || userSaving}>
          <label className="admin-form-field"><span>Nome completo</span><input required minLength={2} maxLength={100} value={userForm.name} onChange={event => setUserForm({ ...userForm, name: event.target.value })} placeholder="Como essa pessoa se chama?" autoComplete="name" /></label>
          <label className="admin-form-field"><span>E-mail</span><div className="admin-input-with-icon"><Mail size={17} /><input required type="email" maxLength={254} value={userForm.email} onChange={event => setUserForm({ ...userForm, email: event.target.value })} placeholder="nome@empresa.com.br" autoComplete="email" /></div></label>
          {access && <label className="admin-form-field"><span>{userForm.id ? 'Nova senha (opcional)' : 'Senha inicial'}</span><input type="password" required={!userForm.id} minLength={12} maxLength={128} value={userPassword} onChange={event => setUserPassword(event.target.value)} placeholder={userForm.id ? 'Deixe em branco para manter a senha atual' : 'Pelo menos 12 caracteres'} autoComplete="new-password" /><small>{userForm.id ? 'Preencha apenas se desejar redefinir a senha.' : 'Informe a senha inicial ao usuário para acessar sua conta.'}</small></label>}
          <label className="admin-form-field"><span>Perfil na operação</span><select value={userForm.role} onChange={event => setUserForm({ ...userForm, role: event.target.value as AppUser['role'] })}><option value="admin">Administrador</option><option value="manager">Gestor</option><option value="driver">Entregador</option></select><small>{userForm.role === 'driver' ? 'Crie um entregador ou vincule este cadastro a alguém da equipe.' : access ? userForm.role === 'admin' ? 'Pode gerenciar usuários, entregas e relatórios.' : 'Acompanha entregas e relatórios, sem acesso à gestão de usuários.' : 'Perfil da prévia local. A aplicação conectada ao servidor controla as permissões de acesso.'}</small></label>
          {userForm.role === 'driver' && <label className="admin-form-field"><span>Entregador vinculado</span><select value={userForm.driverId || ''} onChange={event => setUserForm({ ...userForm, driverId: event.target.value })}><option value="">Criar novo entregador</option>{state.drivers.map(driver => <option key={driver.id} value={driver.id}>{driver.name}</option>)}</select></label>}
          <label className="admin-checkbox-field"><input type="checkbox" checked={userForm.active} onChange={event => setUserForm({ ...userForm, active: event.target.checked })} /><span>Usuário ativo</span></label>
        </fieldset>
        {formError && <p className="admin-validation-error" role="alert">{formError}</p>}
        {access?.error && <p className="admin-validation-error" role="alert">A sincronização está interrompida. Tente novamente pelo aviso do painel antes de salvar.</p>}
        <div className="admin-modal-footer"><button type="button" className="admin-button admin-button-light" disabled={userSaving} onClick={closeUserModal}>Cancelar</button><button type="submit" className="admin-button admin-button-dark" disabled={mutationsBlocked || userSaving}><Check size={17} />{userSaving ? 'Salvando…' : userForm.id ? 'Salvar alterações' : 'Adicionar usuário'}</button></div>
      </form>
    </Modal>}

    {detailDelivery && <Modal title={`Pedido ${detailDelivery.code}`} onClose={closeDetailModal}><div className="admin-detail-content"><div className="admin-detail-customer"><Avatar name={detailDelivery.customer} /><div><h3>{detailDelivery.customer}</h3><span>{detailDelivery.phone}</span></div><StatusBadge status={detailDelivery.status} /></div><div className="admin-detail-address"><MapPin size={22} /><div><span>ENDEREÇO DE ENTREGA</span><strong>{detailDelivery.address}</strong><p>{detailDelivery.neighborhood}</p></div></div><div className="admin-detail-grid"><div><span>Janela de entrega</span><strong>{detailDelivery.window}</strong></div><div><span>{realGps ? 'Estimativa de rota' : access ? 'Distância estimada (simulada)' : 'Distância estimada'}</span><strong>{realGps ? 'Aguardando cálculo por ruas' : `${formatKm(detailDelivery.estimatedKm)} km`}</strong></div><div><span>Entregador</span><strong>{detailDelivery.driverId ? driversById.get(detailDelivery.driverId)?.name || 'Não encontrado' : 'Ainda não atribuído'}</strong></div><div><span>Origem dos dados</span><strong>{access ? simulated ? 'Pedidos demonstrativos compartilhados' : 'Operação compartilhada' : 'Demonstração'}</strong></div></div>{detailDelivery.note && <div className="admin-detail-note"><strong>Observações</strong><p>{detailDelivery.note}</p></div>}{detailDelivery.receivedBy && <div className="admin-detail-received"><CheckCircle2 size={18} /><span>Recebido por <strong>{detailDelivery.receivedBy}</strong></span></div>}{detailDelivery.status === 'pending' && <label className="admin-form-field"><span>Atribuir entregador</span><select disabled={mutationsBlocked} value={detailDelivery.driverId || ''} onChange={event => { if (!mutationsBlocked) void actions.assignDelivery(detailDelivery.id, event.target.value || null); }}><option value="">Sem entregador</option>{state.drivers.map(driver => <option key={driver.id} value={driver.id}>{driver.name}</option>)}</select></label>}<div className="admin-modal-footer"><button className="admin-button admin-button-dark" onClick={closeDetailModal}>Concluir</button></div></div></Modal>}

    {showInfo && <Modal title="Conheça sua próxima operação." onClose={closeInfoModal}><div className="admin-info-modal"><div className="admin-info-modal-icon"><Route size={34} /></div><p>{access ? 'Os cadastros e a atribuição de pedidos são compartilhados com a equipe. Cada usuário acessa a operação conforme seu perfil.' : 'Explore o painel e o app do entregador. Os cadastros, a atribuição de pedidos e as rotas simuladas podem ser alterados e ficam salvos neste navegador.'}</p><ul><li><CheckCircle2 size={18} />Gerencie pedidos e equipe pela central.</li><li><CheckCircle2 size={18} />{access && !simulated ? 'Acompanhe as entregas atribuídas à equipe.' : 'Simule uma entrega no app e acompanhe no mapa.'}</li><li><CheckCircle2 size={18} />{realGps ? 'Exporte distâncias GPS e a origem dos registros em CSV.' : 'Exporte os quilômetros simulados em CSV.'}</li></ul><div className="admin-info-note"><ShieldCheck size={18} /><p>{access ? realGps ? 'O mapa mostra as últimas posições recebidas do aplicativo Android e a distância estimada por GPS. Navegação por ruas será desenvolvida na próxima etapa. A integração com o Alpha7 fica por último.' : 'Esta operação usa mapa, navegação e quilômetros simulados. O rastreamento por GPS está disponível na operação real. A integração com o Alpha7 fica por último.' : 'Login e permissões estão disponíveis na aplicação conectada. GPS e navegação real serão desenvolvidos nas próximas etapas; Alpha7 fica por último.'}</p></div><div className="admin-modal-footer"><button className="admin-button admin-button-dark" onClick={closeInfoModal}>Vamos em frente<ArrowRight size={16} /></button></div></div></Modal>}
  </div>;
}

function MetricCard({ icon, title, value, detail, accent, active = false }: { icon: ReactNode; title: string; value: ReactNode; detail: string; accent: string; active?: boolean }) {
  return <article className={`admin-metric-card${active ? ' admin-metric-highlight' : ''}`}><div className="admin-metric-top"><span className={`admin-metric-icon ${accent}`}>{icon}</span><span className="admin-metric-label">{title}</span>{active && <span className="admin-metric-active-dot" />}</div><strong className="admin-metric-value">{value}</strong><div className="admin-metric-detail">{active ? <span className="admin-live-dot" /> : <span className="admin-metric-detail-dash" />}{detail}</div></article>;
}

function DriverCard({ driver, deliveries, selected, onClick, realGps }: { driver: Driver; deliveries: Delivery[]; selected: boolean; onClick: () => void; realGps: boolean }) {
  const completed = deliveries.filter(delivery => delivery.status === 'delivered').length;
  const current = deliveries.find(delivery => delivery.status === 'in_transit');
  return <button className={`admin-driver-card${selected ? ' is-selected' : ''}`} onClick={onClick} aria-pressed={selected}><div className="admin-driver-card-top"><span className="admin-driver-avatar"><Avatar name={driver.name} color={driver.color} /><span className={`admin-driver-presence ${driver.status}`} /></span><div className="admin-driver-name"><strong>{driver.name}</strong><span>{driver.vehicle}</span></div><span className={`admin-driver-status ${driver.status}`}>{driverStatusLabel[driver.status]}</span></div><div className="admin-driver-card-bottom"><span><Route size={13} /><strong>{formatKm(driver.kmToday)}</strong> km</span><span><Package size={13} /><strong>{completed}/{deliveries.length}</strong> entregas</span><ChevronRight size={15} /></div>{realGps && <div className={`admin-driver-gps-note${validGps(driver.gps) && gpsIsStale(driver.gps) ? ' is-stale' : ''}`}><MapPin size={13} />{validGps(driver.gps) ? `GPS ${gpsAgeLabel(driver.gps)} · ±${Math.round(driver.gps.accuracy)} m` : 'Aguardando localização GPS'}</div>}{selected && <div className="admin-driver-selected-note"><MapPin size={13} />{current ? `Entrega para ${current.neighborhood}` : driver.status === 'offline' ? realGps ? 'Entregador fora do turno' : 'Entregador offline · última posição simulada' : 'Aguardando a próxima entrega'}</div>}</button>;
}
