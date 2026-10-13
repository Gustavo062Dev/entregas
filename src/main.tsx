import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { Info, X } from 'lucide-react';
import AdminApp from './admin/AdminApp';
import DriverApp from './driver/DriverApp';
import { useDemo } from './store';
import { useConnectedApp } from './connected';
import Login from './auth/Login';
import { driverScreen } from './navigation';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';
import './styles.css';

function useNotice() {
  const [notice, setNotice] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    if (timer.current) clearTimeout(timer.current);
    setNotice(message); timer.current = setTimeout(() => setNotice(''), 5200);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { notify, toast: notice && <div className="app-toast" role="status"><Info size={19} /><span>{notice}</span><button aria-label="Fechar aviso" onClick={() => setNotice('')}><X size={17} /></button></div> };
}

const isDriver = Capacitor.isNativePlatform() || driverScreen();

function DemoApp() {
  const { notify, toast } = useNotice();
  const { state, actions } = useDemo(notify);
  return <>{isDriver ? <DriverApp state={state} actions={actions} /> : <AdminApp state={state} actions={actions} />}{toast}</>;
}

function ConnectedApp() {
  const { notify, toast } = useNotice();
  const app = useConnectedApp(notify);
  const allowed = app.user && (isDriver ? app.user.role === 'driver' : app.user.role !== 'driver');
  const wrongProfile = Boolean(app.user && !allowed);

  if (allowed && app.state) {
    const access = { user: app.user!, signOut: app.logout, syncing: app.syncing, error: app.error, refresh: app.refresh, simulation: app.simulation };
    return <>{isDriver ? <DriverApp state={app.state} actions={app.actions} access={access} /> : <AdminApp state={app.state} actions={app.actions} access={access} />}{toast}</>;
  }
  if (allowed && app.status === 'unavailable') return <main className="app-connection-screen"><Info size={32} /><h1>Não foi possível carregar a operação</h1><p role="alert">{app.error}</p><button onClick={() => void app.refresh()} disabled={app.syncing}>Tentar novamente</button><button onClick={() => void app.logout()}>Sair da conta</button>{toast}</main>;
  return <><Login driver={isDriver} apiUrl={app.apiUrl} needsServer={Capacitor.isNativePlatform()} loading={app.status === 'loading'} error={wrongProfile ? (isDriver ? 'Entre com uma conta de entregador para abrir o aplicativo.' : 'Seu perfil de entregador acessa o aplicativo. Entre com uma conta administrativa para abrir este painel.') : app.error} onLogin={async (email, password, apiUrl) => {
    if (wrongProfile) await app.logout();
    return app.login(email, password, apiUrl);
  }} />{toast}</>;
}

const App = import.meta.env.MODE === 'portable' ? DemoApp : ConnectedApp;
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
