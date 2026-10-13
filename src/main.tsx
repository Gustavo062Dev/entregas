import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { Info, X } from 'lucide-react';
import AdminApp from './admin/AdminApp';
import DriverApp from './driver/DriverApp';
import { useDemo } from './store';
import { driverScreen } from './navigation';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';
import './styles.css';

function App() {
  const [notice, setNotice] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    if (timer.current) clearTimeout(timer.current);
    setNotice(message); timer.current = setTimeout(() => setNotice(''), 5200);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const { state, actions } = useDemo(notify);
  const isDriver = Capacitor.isNativePlatform() || driverScreen();
  return <>
    {isDriver ? <DriverApp state={state} actions={actions} /> : <AdminApp state={state} actions={actions} />}
    {notice && <div className="app-toast" role="status"><Info size={19} /><span>{notice}</span><button aria-label="Fechar aviso" onClick={() => setNotice('')}><X size={17} /></button></div>}
  </>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
