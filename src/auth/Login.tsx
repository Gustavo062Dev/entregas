import { useId, useState, type FormEvent } from 'react';
import { ArrowRight, Eye, EyeOff, LockKeyhole, MapPin, Route, ShieldCheck, Truck } from 'lucide-react';
import './login.css';

export interface LoginProps {
  driver: boolean;
  apiUrl: string;
  needsServer: boolean;
  loading: boolean;
  error: string;
  onLogin: (email: string, password: string, apiUrl?: string) => Promise<boolean>;
}

export default function Login({ driver, apiUrl, needsServer, loading, error, onLogin }: LoginProps) {
  const id = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState(apiUrl);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [unexpectedError, setUnexpectedError] = useState('');
  const busy = loading || submitting;
  const message = unexpectedError || error;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setUnexpectedError('');
    setSubmitting(true);
    try {
      await onLogin(email.trim(), password, needsServer ? server.trim() : undefined);
    } catch {
      setUnexpectedError('Não foi possível entrar. Verifique sua conexão e tente novamente.');
    } finally {
      setSubmitting(false);
    }
  }

  return <main className={`rota-login${driver ? ' rota-login-driver' : ''}`}>
    <div className="rota-login-shell">
      <aside className="rota-login-intro">
        <div className="rota-login-brand"><span><Route size={27} aria-hidden="true" /></span><strong>rota<span>.</span></strong></div>
        <div className="rota-login-intro-content">
          <span className="rota-login-eyebrow">GESTÃO DE ENTREGAS</span>
          <h2>{driver ? 'Cada entrega começa com um bom caminho.' : 'Sua operação, em um só lugar.'}</h2>
          <p>{driver ? 'Acesse suas entregas e acompanhe sua jornada pelo aplicativo.' : 'Organize entregas, acompanhe sua equipe e consulte os quilômetros da operação.'}</p>
          <div className="rota-login-journey" aria-hidden="true">
            <span className="rota-login-journey-point"><Truck size={22} /></span>
            <span className="rota-login-journey-path" />
            <span className="rota-login-journey-point rota-login-journey-destination"><MapPin size={22} /></span>
          </div>
        </div>
        <span className="rota-login-intro-footer">Conectando sua equipe à próxima entrega.</span>
      </aside>

      <section className="rota-login-panel" aria-labelledby={`${id}-title`}>
        <div className="rota-login-form-heading">
          <span className="rota-login-access"><ShieldCheck size={15} aria-hidden="true" />{driver ? 'APP DO ENTREGADOR' : 'PAINEL ADMINISTRATIVO'}</span>
          <h1 id={`${id}-title`}>{driver ? 'Vamos começar?' : 'Bem-vindo ao Rota'}</h1>
          <p>Entre com o acesso fornecido pela sua empresa.</p>
        </div>

        <form className="rota-login-form" onSubmit={submit} aria-busy={busy}>
          {message && <div className="rota-login-error" role="alert" id={`${id}-error`}>{message}</div>}

          {needsServer && <div className="rota-login-field">
            <label htmlFor={`${id}-server`}>Endereço do servidor</label>
            <input id={`${id}-server`} name="server" type="url" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="https://central.suaempresa.com.br" value={server} onChange={event => setServer(event.target.value)} disabled={busy} required aria-describedby={`${id}-server-help`} />
            <p className="rota-login-field-help" id={`${id}-server-help`}>Peça esse endereço ao administrador para conectar o aplicativo à central da sua empresa.</p>
          </div>}

          <div className="rota-login-field">
            <label htmlFor={`${id}-email`}>E-mail</label>
            <input id={`${id}-email`} name="email" type="email" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="voce@suaempresa.com.br" value={email} onChange={event => setEmail(event.target.value)} disabled={busy} required maxLength={254} />
          </div>

          <div className="rota-login-field">
            <label htmlFor={`${id}-password`}>Senha</label>
            <div className="rota-login-password">
              <input id={`${id}-password`} name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Digite sua senha" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} required />
              <button type="button" onClick={() => setShowPassword(value => !value)} disabled={busy} aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'} aria-pressed={showPassword}>{showPassword ? <EyeOff size={19} aria-hidden="true" /> : <Eye size={19} aria-hidden="true" />}</button>
            </div>
          </div>

          <button className="rota-login-submit" type="submit" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}{busy ? <span className="rota-login-spinner" aria-hidden="true" /> : <ArrowRight size={19} aria-hidden="true" />}</button>
        </form>

        <div className="rota-login-help"><LockKeyhole size={17} aria-hidden="true" /><p>Seu acesso é criado pelo administrador da operação. Se precisar de ajuda com a senha, entre em contato com ele.</p></div>
      </section>
    </div>
  </main>;
}
