import { Capacitor } from '@capacitor/core';
import {
  ArrowDownRight, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown,
  ChevronRight, Clock3, Gauge, History, LogOut, Mail, MapPin, Navigation, Package, Phone,
  Power, RefreshCw, Route, ShieldCheck, Truck, UserRound, X,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import MapCanvas from '../components/MapCanvas';
import { screenHref } from '../navigation';
import { deliveryStatusLabel, formatKm, type Delivery, type ScreenProps } from '../types';
import './driver.css';

type DriverTab = 'route' | 'deliveries' | 'history' | 'profile';
const PROFILE_STORAGE = 'rota.demo.driver';

function readDriver() {
  try { return localStorage.getItem(PROFILE_STORAGE); } catch { return null; }
}

function Sheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const container = panel.current;
    const selectors = 'button:not([disabled]), input, select, textarea, a[href], [tabindex="0"]';
    const focusable = () => Array.from(container?.querySelectorAll<HTMLElement>(selectors) ?? []);
    (container?.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0])?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') close.current();
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = previousOverflow; previous?.focus(); };
  }, []);
  return (
    <div className="driver-sheet-backdrop" onClick={onClose}>
      <div className="driver-sheet" ref={panel} role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}>
        <div className="driver-sheet-handle" />
        <header><h2>{title}</h2><button type="button" className="driver-icon-button" onClick={onClose} aria-label="Fechar janela"><X size={20} /></button></header>
        {children}
      </div>
    </div>
  );
}

export default function DriverApp({ state, actions, access }: ScreenProps) {
  const [driverId, setDriverId] = useState(() => readDriver() ?? state.drivers[0]?.id ?? '');
  const [tab, setTab] = useState<DriverTab>('route');
  const [chooseDriver, setChooseDriver] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [receivedBy, setReceivedBy] = useState('');
  const [deliveryFilter, setDeliveryFilter] = useState<'pending' | 'delivered'>('pending');
  const [submitting, setSubmitting] = useState(false);
  const mutationPending = useRef(false);
  const driver = access
    ? state.drivers.find(item => item.id === access.user.driverId)
    : state.drivers.find(item => item.id === driverId) ?? state.drivers[0];
  const native = Capacitor.isNativePlatform();
  const busy = submitting || Boolean(access?.syncing) || Boolean(access?.error);
  const simulation = access?.simulation ?? true;

  useEffect(() => {
    if (access || !driver) return;
    try { localStorage.setItem(PROFILE_STORAGE, driver.id); } catch { /* A seleção segue disponível sem armazenamento. */ }
  }, [access, driver?.id]);

  const connectionBanner = access && <div className={`driver-connection-banner ${access.error ? 'error' : ''}`} role={access.error ? 'alert' : 'status'}><RefreshCw size={17} className={access.syncing ? 'driver-sync-icon' : ''} /><div><strong>{access.error ? 'Não foi possível atualizar os dados' : access.syncing ? 'Atualizando suas entregas…' : 'Dados compartilhados'}</strong><p>{access.error || (access.syncing ? 'Aguarde para registrar alterações.' : 'Suas entregas são sincronizadas com o painel.')}</p></div><button type="button" disabled={access.syncing || submitting} onClick={() => void access.refresh()}>{access.error ? 'Tentar novamente' : 'Atualizar'}</button></div>;

  if (!driver) return access
    ? <div className={`driver-page driver-access-empty ${native ? 'driver-native' : ''}`}><div className="driver-access-card"><div className="driver-empty"><Truck size={32} /><h2>Seu acesso precisa de um entregador</h2><p>A conta de {access.user.name} ainda não está vinculada a um entregador disponível. Solicite ao administrador que confira seu cadastro.</p><span className="driver-access-email">{access.user.email}</span></div>{connectionBanner}<button className="driver-secondary" type="button" onClick={() => void access.signOut()}><LogOut size={18} /> Sair</button></div></div>
    : <div className="driver-empty"><Truck size={32} /><h2>Nenhum entregador cadastrado</h2><p>Cadastre um entregador no painel para visualizar o aplicativo.</p>{!native && <a href={screenHref('admin')}>Abrir painel administrativo</a>}</div>;

  const currentDriverId = driver.id;
  const assigned = state.deliveries.filter(delivery => delivery.driverId === currentDriverId);
  const pending = assigned.filter(delivery => delivery.status === 'pending');
  const delivered = assigned.filter(delivery => delivery.status === 'delivered');
  const active = assigned.find(delivery => delivery.status === 'in_transit');
  const nextDelivery = active ?? pending[0];
  const trip = active ? state.trips.find(item => item.deliveryId === active.id && !item.finishedAt) : undefined;
  const driverTrips = state.trips.filter(item => item.driverId === driver.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const online = driver.status !== 'offline';
  const userActive = access ? access.user.active : state.users.some(item => item.driverId === driver.id && item.active);
  const todayCount = delivered.filter(delivery => state.trips.some(item => item.deliveryId === delivery.id && item.date === state.demoDate && item.finishedAt)).length;
  const dayLabel = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long' }).format(new Date(`${state.demoDate}T12:00:00`));
  const navigationStep = Math.min(3, Math.floor((trip?.progress ?? 0) * 4));
  const directions = [
    { text: 'Siga em frente', street: 'Continue pela rota destacada', distance: 'Percurso simulado', icon: Navigation },
    { text: 'Vire à direita', street: `Em direção a ${active?.neighborhood ?? 'seu destino'}`, distance: 'Próxima etapa simulada', icon: ArrowUpRight },
    { text: 'Siga pela via principal', street: 'Aproximando-se do endereço de entrega', distance: 'Trecho final simulado', icon: ArrowDownRight },
    { text: trip?.progress === 1 ? 'Você chegou ao destino' : 'O destino está à frente', street: active?.address ?? '', distance: trip?.progress === 1 ? 'Simulação concluída' : 'Última etapa simulada', icon: MapPin },
  ];
  const DirectionIcon = directions[navigationStep].icon;

  function selectDriver(id: string) {
    setDriverId(id);
    setChooseDriver(false);
    setConfirmId(null);
    setTab('route');
  }

  async function mutate(action: () => boolean | Promise<boolean>, onSuccess?: () => void) {
    if (busy || mutationPending.current) return;
    mutationPending.current = true;
    setSubmitting(true);
    try {
      if (await action()) onSuccess?.();
    } catch {
      actions.notify('Não foi possível salvar a alteração. Atualize os dados e tente novamente.');
    } finally {
      mutationPending.current = false;
      setSubmitting(false);
    }
  }

  function begin(delivery: Delivery) {
    void mutate(() => actions.startRoute(delivery.id, currentDriverId), () => setTab('route'));
  }

  function openConfirmation(delivery: Delivery) {
    if (busy) return;
    setReceivedBy('');
    setConfirmId(delivery.id);
  }

  function confirmDelivery(event: FormEvent) {
    event.preventDefault();
    if (!confirmId || !receivedBy.trim() || busy) return;
    const deliveryId = confirmId;
    void mutate(() => actions.completeDelivery(deliveryId, receivedBy.trim()), () => setConfirmId(null));
  }

  function changeAvailability(online: boolean) {
    void mutate(() => actions.setDriverAvailability(currentDriverId, online));
  }

  const routeCard = (delivery: Delivery, compact = false) => (
    <article className={`driver-delivery-card ${compact ? 'compact' : ''}`} key={delivery.id}>
      <div className="driver-card-top"><span className="driver-order-code"><Package size={15} /> {delivery.code}</span><span className={`driver-delivery-status ${delivery.status}`}>{deliveryStatusLabel[delivery.status]}</span></div>
      <h3>{delivery.customer}</h3>
      <div className="driver-address"><MapPin size={18} /><div><strong>{delivery.address}</strong><span>{delivery.neighborhood}</span></div></div>
      <div className="driver-delivery-meta"><span><Clock3 size={14} /> {delivery.window}</span><span><Route size={14} /> {formatKm(delivery.estimatedKm)} km estimados</span></div>
      {delivery.note && <p className="driver-delivery-note">{delivery.note}</p>}
      {delivery.status === 'pending' && <button className="driver-primary" type="button" disabled={busy || !online || Boolean(active) || !userActive} onClick={() => begin(delivery)}><Navigation size={18} /> Iniciar rota<ArrowRight size={18} /></button>}
      {delivery.status === 'in_transit' && compact && <button className="driver-secondary" type="button" onClick={() => setTab('route')}>Ver navegação<ArrowRight size={17} /></button>}
      {delivery.status === 'delivered' && <div className="driver-receipt"><CheckCheck size={16} /> Recebido por {delivery.receivedBy || 'cliente'}</div>}
    </article>
  );

  return (
    <div className={`driver-page ${native ? 'driver-native' : ''}`}>
      {!native && <aside className="driver-preview-context">
        <a className="driver-desktop-brand" href={screenHref(access ? 'driver' : 'admin')}><Route size={28} /> rota<span>.</span></a>
        <span className="driver-preview-label">APLICATIVO DO ENTREGADOR</span>
        <h1>Cada entrega.<br />No caminho certo<span>.</span></h1>
        <p>Sua rota, suas entregas e os quilômetros do dia. Tudo em um só lugar.</p>
        <div className="driver-preview-feature"><span><Navigation size={19} /></span><div><strong>Navegação no aplicativo</strong><small>Interface de orientação integrada</small></div></div>
        <div className="driver-preview-feature"><span><Gauge size={19} /></span><div><strong>Quilômetros organizados</strong><small>Histórico de cada percurso</small></div></div>
        <div className="driver-preview-feature"><span><Package size={19} /></span><div><strong>Entregas em poucos toques</strong><small>Da saída à confirmação</small></div></div>
        {!access && <a className="driver-back-link" href={screenHref('admin')}>Abrir painel administrativo <ArrowUpRight size={17} /></a>}
        <p className="driver-context-note">{access ? <>Conta conectada ao painel.<br />Mapa e quilômetros ainda simulados.</> : <>Prévia das telas para Android.<br />Dados e percursos de demonstração.</>}</p>
      </aside>}

      <div className="driver-phone">
        <header className="driver-header">
          <div className="driver-header-brand"><span><Route size={21} /> rota<span className="driver-brand-dot">.</span></span><span className="driver-demo-chip">{access ? 'Conta conectada' : 'Demonstração'}</span></div>
          <div className="driver-greeting"><div><span>Olá, {(access?.user.name ?? driver.name).split(' ')[0]} <span aria-hidden="true">✦</span></span><h2>Vamos fazer<br />um bom caminho.</h2></div><button className="driver-profile-switch" type="button" onClick={() => access ? setTab('profile') : setChooseDriver(true)} aria-label={access ? 'Abrir meu perfil' : `Trocar entregador. Perfil atual: ${driver.name}`}><span style={{ backgroundColor: driver.color }}>{driver.initials}</span>{!access && <ChevronDown size={14} />}</button></div>
          <div className="driver-shift"><span className={`driver-shift-dot ${online ? 'online' : ''}`} /><span>{!userActive ? (access ? 'Perfil desativado' : 'Perfil de demonstração desativado') : active ? 'Você está em rota' : online ? 'Seu turno está em andamento' : 'Você está fora do turno'}</span><button type="button" disabled={busy || Boolean(active) || !userActive} onClick={() => changeAvailability(!online)}>{online ? 'Encerrar' : 'Iniciar turno'}<Power size={13} /></button></div>
        </header>

        <main className="driver-main">
          {connectionBanner}
          {tab === 'route' && <>
            <div className="driver-section-title"><h2>Minha rota</h2><span>{dayLabel}</span></div>
            <div className="driver-stats"><article><span className="driver-stat-icon"><Route size={20} /></span><div><strong>{formatKm(driver.kmToday)}<small> km</small></strong><span>Rodados hoje · simulação</span></div></article><article><span className="driver-stat-icon"><Package size={20} /></span><div><strong>{todayCount}<small> / {assigned.length}</small></strong><span>Entregas concluídas</span></div></article></div>

            {!userActive ? <div className="driver-offline-banner"><ShieldCheck size={18} /><div><strong>Perfil desativado</strong><p>Um administrador precisa reativar este perfil no painel.</p></div></div> : !online && <div className="driver-offline-banner"><Power size={18} /><div><strong>Pronto para começar?</strong><p>Inicie o turno para iniciar uma rota.</p></div><button type="button" disabled={busy} onClick={() => changeAvailability(true)}>Iniciar</button></div>}

            {active ? <>
              <div className="driver-section-title small"><h3>Navegação</h3><span className="driver-live-label"><span /> Simulação</span></div>
              <div className="driver-navigation-card">
                <div className="driver-direction"><span className="driver-direction-icon"><DirectionIcon size={34} /></span><div><small>{directions[navigationStep].distance}</small><strong>{directions[navigationStep].text}</strong><p>{directions[navigationStep].street}</p></div></div>
                <div className="driver-active-map"><MapCanvas drivers={[driver]} deliveries={[active]} selectedDriverId={driver.id} activeDeliveryId={active.id} compact /></div>
                <div className="driver-route-progress"><div><span>{formatKm(trip?.km ?? 0)} km simulados</span><strong>{Math.round((trip?.progress ?? 0) * 100)}%</strong></div><progress value={trip?.progress ?? 0} max={1} aria-label="Progresso do percurso simulado" /></div>
                <div className="driver-navigation-footer"><span><Package size={17} /><strong>{active.customer}</strong></span><span>{active.code}</span></div>
                {(trip?.progress ?? 0) < 1 ? (simulation ? <button className="driver-primary" type="button" disabled={busy || !userActive} onClick={() => void mutate(() => actions.advanceRoute(active.id))}>Avançar simulação<ArrowRight size={18} /></button> : <p className="driver-gps-pending"><Navigation size={17} /> A captura por GPS e a navegação real serão conectadas na próxima etapa.</p>) : <button className="driver-primary" type="button" disabled={busy || !userActive} onClick={() => openConfirmation(active)}><Check size={18} /> Confirmar entrega<ArrowRight size={18} /></button>}
                <p className="driver-map-disclaimer">Mapa ilustrativo. Esta prévia não usa GPS nem fornece orientação de trânsito real.</p>
              </div>
              {pending.length > 0 && <div className="driver-up-next"><span className="driver-next-icon"><Package size={18} /></span><div><small>Depois desta entrega</small><strong>{pending[0].customer}</strong><span>{pending[0].neighborhood}</span></div><span>+{pending.length}</span></div>}
            </> : nextDelivery ? <>
              <div className="driver-section-title small"><h3>Próxima entrega</h3><span>{pending.length} na sua rota</span></div>
              <div className="driver-preview-map"><MapCanvas drivers={[driver]} deliveries={pending} selectedDriverId={driver.id} activeDeliveryId={nextDelivery.id} compact /></div>
              {routeCard(nextDelivery)}
              <div className="driver-journey-preview"><span className="driver-journey-node"><span /></span><div><strong>Seu ponto de saída</strong><small>Posição de demonstração</small></div><span className="driver-journey-line" /><span className="driver-journey-node destination"><MapPin size={15} /></span><div><strong>{nextDelivery.neighborhood}</strong><small>{formatKm(nextDelivery.estimatedKm)} km estimados de percurso</small></div></div>
              {active === undefined && pending.length > 1 && <button className="driver-text-button" type="button" onClick={() => setTab('deliveries')}>Ver mais {pending.length - 1} {pending.length === 2 ? 'entrega' : 'entregas'}<ChevronRight size={17} /></button>}
            </> : <div className="driver-empty"><span><CheckCheck size={31} /></span><h3>Tudo em dia por aqui</h3><p>Você não tem entregas pendentes. Novas entregas atribuídas no painel aparecerão aqui.</p><button className="driver-secondary" type="button" onClick={() => setTab('history')}>Ver meu histórico<ArrowRight size={16} /></button></div>}
          </>}

          {tab === 'deliveries' && <>
            <div className="driver-section-title"><h2>Minhas entregas</h2><span>{assigned.length} no total</span></div>
            <p className="driver-page-description">Tudo que está no seu caminho hoje.</p>
            <div className="driver-tabs" aria-label="Filtrar entregas"><button type="button" aria-pressed={deliveryFilter === 'pending'} className={deliveryFilter === 'pending' ? 'active' : ''} onClick={() => setDeliveryFilter('pending')}>A fazer <span>{pending.length + (active ? 1 : 0)}</span></button><button type="button" aria-pressed={deliveryFilter === 'delivered'} className={deliveryFilter === 'delivered' ? 'active' : ''} onClick={() => setDeliveryFilter('delivered')}>Concluídas <span>{delivered.length}</span></button></div>
            {active && deliveryFilter === 'pending' && <p className="driver-list-note"><Navigation size={16} /> Conclua o percurso atual antes de iniciar outra entrega.</p>}
            {!userActive && <p className="driver-list-note"><ShieldCheck size={16} /> Este perfil está desativado. Um administrador precisa reativá-lo no painel.</p>}
            {!online && userActive && deliveryFilter === 'pending' && <p className="driver-list-note"><Power size={16} /> Inicie seu turno na aba Minha rota para começar.</p>}
            <div className="driver-delivery-list">{(deliveryFilter === 'pending' ? assigned.filter(item => item.status !== 'delivered') : delivered).map(item => routeCard(item, true))}</div>
            {(deliveryFilter === 'pending' ? pending.length + (active ? 1 : 0) : delivered.length) === 0 && <div className="driver-empty"><span><Package size={30} /></span><h3>{deliveryFilter === 'pending' ? 'Nenhuma entrega pendente' : 'Seu histórico começa aqui'}</h3><p>{deliveryFilter === 'pending' ? 'As novas entregas atribuídas a você aparecerão nesta lista.' : 'Depois de confirmar uma entrega, você poderá consultar os detalhes aqui.'}</p></div>}
          </>}

          {tab === 'history' && <>
            <div className="driver-section-title"><h2>Meu histórico</h2><History size={20} /></div>
            <p className="driver-page-description">Cada percurso conta uma história.</p>
            <div className="driver-history-hero"><span><Route size={24} /> Quilômetros do dia</span><strong>{formatKm(driver.kmToday)}<small> km</small></strong><p>Distâncias de demonstração · {dayLabel}</p></div>
            <div className="driver-section-title small"><h3>Percursos</h3><span>{driverTrips.length} registros</span></div>
            <div className="driver-history-list">{driverTrips.map(item => { const delivery = state.deliveries.find(value => value.id === item.deliveryId); return <article key={item.id}><span className={`driver-history-icon ${item.finishedAt ? 'finished' : ''}`}>{item.finishedAt ? <CheckCheck size={20} /> : <Navigation size={20} />}</span><div><strong>{delivery?.customer ?? 'Percurso de demonstração'}</strong><span>{delivery?.code ?? 'Histórico'} · {new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(new Date(`${item.date}T12:00:00`))}</span><small>{item.finishedAt ? 'Entrega concluída' : 'Percurso em andamento'}</small></div><strong>{formatKm(item.km)}<small> km</small></strong></article>; })}</div>
            {driverTrips.length === 0 && <div className="driver-empty"><span><History size={30} /></span><h3>Um novo caminho começa aqui</h3><p>Inicie uma rota para registrar seu primeiro percurso de demonstração.</p><button className="driver-secondary" type="button" onClick={() => setTab('route')}>Ir para minha rota<ArrowRight size={16} /></button></div>}
            <p className="driver-history-note"><ShieldCheck size={16} /> Os quilômetros são simulados. O rastreamento por GPS será conectado em uma próxima etapa.</p>
          </>}

          {tab === 'profile' && <>
            <div className="driver-section-title"><h2>Meu perfil</h2><UserRound size={20} /></div>
            <div className="driver-profile-card"><span className="driver-large-avatar" style={{ backgroundColor: driver.color }}>{driver.initials}</span><h3>{access?.user.name ?? driver.name}</h3>{access && <p className="driver-profile-email"><Mail size={14} /> {access.user.email}</p>}<span className={`driver-profile-status ${online ? 'online' : ''}`}><span />{!userActive ? 'Perfil desativado' : active ? 'Em rota' : online ? 'Disponível para entregas' : 'Fora do turno'}</span></div>
            <div className="driver-profile-details"><div><span><Truck size={19} /> Veículo</span><strong>{driver.vehicle}</strong></div><div><span><Phone size={19} /> Telefone</span><strong>{driver.phone}</strong></div><div><span><Package size={19} /> Entregas atribuídas</span><strong>{assigned.length}</strong></div></div>
            {!access && <button className="driver-secondary" type="button" onClick={() => setChooseDriver(true)}><UserRound size={18} /> Trocar entregador de demonstração<ChevronRight size={18} /></button>}
            <button className="driver-shift-button" type="button" disabled={busy || Boolean(active) || !userActive} onClick={() => changeAvailability(!online)}><Power size={18} />{online ? 'Encerrar meu turno' : 'Iniciar meu turno'}</button>
            {!userActive && <p className="driver-profile-note">Este perfil precisa ser reativado por um administrador no painel.</p>}
            {active && <p className="driver-profile-note">Conclua a entrega em andamento para encerrar seu turno.</p>}
            <div className="driver-demo-explainer"><span><ShieldCheck size={20} /></span><div><strong>{access ? 'Sua conta está conectada' : 'Você está na versão de demonstração'}</strong><p>{access ? 'Seu acesso e suas entregas são compartilhados com o painel. O mapa, as posições e os quilômetros continuam simulados até a conexão por GPS.' : 'Este perfil não é um login autenticado. As entregas, posições e quilômetros são dados locais para explorar as telas.'}</p></div></div>
            {access && <button className="driver-sign-out" type="button" onClick={() => void access.signOut()}><LogOut size={18} /> Sair</button>}
            {!native && !access && <a className="driver-admin-mobile-link" href={screenHref('admin')}>Abrir painel administrativo<ArrowUpRight size={17} /></a>}
          </>}
        </main>

        <nav className="driver-bottom-nav" aria-label="Navegação do entregador">
          {([{ id: 'route', title: 'Minha rota', icon: Navigation }, { id: 'deliveries', title: 'Entregas', icon: Package }, { id: 'history', title: 'Histórico', icon: History }, { id: 'profile', title: 'Perfil', icon: UserRound }] as const).map(item => <button key={item.id} type="button" className={tab === item.id ? 'active' : ''} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}><span><item.icon size={21} /></span>{item.title}</button>)}
        </nav>
      </div>

      {chooseDriver && !access && <Sheet title="Escolher entregador" onClose={() => setChooseDriver(false)}><p className="driver-sheet-description">Explore as telas com um perfil de demonstração. A seleção fica salva neste dispositivo.</p><div className="driver-picker-list">{state.drivers.map(item => <button type="button" key={item.id} className={item.id === driver.id ? 'selected' : ''} onClick={() => selectDriver(item.id)}><span style={{ backgroundColor: item.color }}>{item.initials}</span><div><strong>{item.name}</strong><small>{item.vehicle} · {item.status === 'offline' ? 'Fora do turno' : item.status === 'on_route' ? 'Em rota' : 'Disponível'}</small></div>{item.id === driver.id ? <Check size={19} /> : <ChevronRight size={18} />}</button>)}</div></Sheet>}
      {confirmId && <Sheet title="Confirmar entrega" onClose={() => { if (!submitting) setConfirmId(null); }}><div className="driver-confirm-symbol"><CheckCheck size={30} /></div><p className="driver-sheet-description">Quem recebeu o pedido de <strong>{state.deliveries.find(item => item.id === confirmId)?.customer}</strong>?</p><form onSubmit={confirmDelivery}><label className="driver-field-label" htmlFor="driver-received-by">Nome de quem recebeu</label><input data-autofocus id="driver-received-by" className="driver-input" placeholder="Digite o nome do recebedor" value={receivedBy} onChange={event => setReceivedBy(event.target.value)} required maxLength={120} autoComplete="off" disabled={submitting} /><button className="driver-primary" type="submit" disabled={busy || !receivedBy.trim()}><Check size={18} /> {submitting ? 'Confirmando…' : 'Confirmar entrega'}</button><p className="driver-confirm-note">{access ? 'A confirmação encerra o percurso simulado e atualiza as entregas no painel.' : 'A confirmação encerra o percurso simulado e atualiza as telas de demonstração.'}</p></form></Sheet>}
    </div>
  );
}
