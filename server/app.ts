import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { transition, type Command } from '../src/domain.ts';
import type { AppState, AppUser } from '../src/types.ts';
import { HttpError } from './errors.ts';
import { openRepository, type RepositoryOptions, type Snapshot } from './repository.ts';
import { exactBody, normalizeEmail, validateCommand, validatePassword, validateUser } from './validation.ts';

export interface ApiOptions extends RepositoryOptions {
  staticDir?: string;
  allowedOrigins?: string[];
}
const MAX_BODY = 32 * 1024;
const LOGIN_WINDOW = 10 * 60 * 1000;

async function readBody(request: IncomingMessage): Promise<unknown> {
  if ((request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Envie o conteúdo como application/json.');
  }
  const length = Number(request.headers['content-length'] ?? 0);
  if (length > MAX_BODY) throw new HttpError(413, 'A solicitação excede o limite de 32 KB.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY) {
      request.resume();
      throw new HttpError(413, 'A solicitação excede o limite de 32 KB.');
    }
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'JSON inválido.'); }
}

function send(response: ServerResponse, status: number, data?: unknown) {
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  if (data === undefined) { response.end(); return; }
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(data));
}

function bearer(request: IncomingMessage) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization ?? '');
  if (!match) throw new HttpError(401, 'Entre na sua conta para continuar.');
  return match[1];
}

function stateForUser(state: AppState, user: AppUser): AppState {
  if (user.role !== 'driver') return state;
  return { ...state, users: state.users.filter(item => item.id === user.id),
    drivers: state.drivers.filter(driver => driver.id === user.driverId),
    deliveries: state.deliveries.filter(delivery => !!user.driverId && delivery.driverId === user.driverId),
    trips: state.trips.filter(trip => !!user.driverId && trip.driverId === user.driverId) };
}

function authorizeCommand(command: Command, user: AppUser, state: AppState, demoSeed: boolean) {
  if (command.type === 'save-user') throw new HttpError(403, 'Use o cadastro de usuários para alterar contas.');
  if (command.type === 'reset') throw new HttpError(403, 'A restauração da demonstração não está disponível no servidor.');
  if (command.type === 'advance' && !demoSeed) throw new HttpError(403, 'O avanço simulado está disponível somente em demonstração.');
  if (user.role === 'admin') return;
  if (user.role === 'manager' && command.type === 'assign') return;
  if (user.role !== 'driver' || !user.driverId) throw new HttpError(403, 'Sua conta não tem permissão para esta ação.');
  if (command.type === 'availability' && command.driverId === user.driverId) return;
  if (command.type === 'start' && command.driverId === user.driverId && state.deliveries.some(delivery => delivery.id === command.deliveryId && delivery.driverId === user.driverId)) return;
  if ((command.type === 'advance' || command.type === 'complete') && state.deliveries.some(delivery => delivery.id === command.deliveryId && delivery.driverId === user.driverId)) return;
  throw new HttpError(403, 'Sua conta não tem permissão para esta ação.');
}

function createLoginLimiter(now: () => number) {
  const buckets = new Map<string, { attempts: number; resetAt: number }>();
  return (address: string, email: string) => {
    const time = now();
    for (const [key, value] of buckets) if (value.resetAt <= time) buckets.delete(key);
    const keys = [[`ip:${address}`, 30], [`account:${address}:${email}`, 5]] as const;
    for (const [key, limit] of keys) {
      if ((buckets.get(key)?.attempts ?? 0) >= limit) throw new HttpError(429, 'Muitas tentativas. Aguarde 10 minutos antes de tentar novamente.');
    }
    if (buckets.size > 10_000) throw new HttpError(429, 'Muitas tentativas. Aguarde antes de tentar novamente.');
    for (const [key] of keys) {
      const bucket = buckets.get(key) ?? { attempts: 0, resetAt: time + LOGIN_WINDOW };
      bucket.attempts++;
      buckets.set(key, bucket);
    }
  };
}

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff' };

async function serveStatic(request: IncomingMessage, response: ServerResponse, pathname: string, directory: string) {
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'Endereço inválido.'); }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) throw new HttpError(400, 'Endereço inválido.');
  let root: string;
  try { root = await realpath(directory); } catch { throw new HttpError(404, 'A interface ainda não foi compilada.'); }
  const indexFile = async () => {
    try { return await realpath(resolve(root, 'index.html')); }
    catch { throw new HttpError(404, 'A interface ainda não foi compilada.'); }
  };
  const candidate = resolve(root, `.${decoded}`);
  const isWithin = (path: string) => { const pathFromRoot = relative(root, path); return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !pathFromRoot.startsWith(sep)); };
  if (!isWithin(candidate)) throw new HttpError(404, 'Página não encontrada.');
  let file: string;
  try { file = await realpath(candidate); }
  catch {
    if (extname(decoded)) throw new HttpError(404, 'Arquivo não encontrado.');
    file = await indexFile();
  }
  if (!isWithin(file)) throw new HttpError(404, 'Arquivo não encontrado.');
  let bytes: Buffer;
  try { bytes = await readFile(file); }
  catch {
    if (decoded === '/') {
      file = await indexFile();
      if (!isWithin(file)) throw new HttpError(404, 'Arquivo não encontrado.');
      bytes = await readFile(file);
    } else throw new HttpError(404, 'Arquivo não encontrado.');
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
  response.setHeader('Content-Length', bytes.length);
  response.setHeader('Cache-Control', extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600');
  response.end(request.method === 'HEAD' ? undefined : bytes);
}

export function createApiServer(options: ApiOptions = {}) {
  const repository = openRepository(options);
  const now = options.now ?? Date.now;
  const checkLoginLimit = createLoginLimiter(now);
  const allowedOrigins = options.allowedOrigins ?? (process.env.ROTA_ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean);
  const staticDir = options.staticDir ?? (process.env.NODE_ENV === 'production' ? resolve('dist') : undefined);
  const snapshotFor = (snapshot: Snapshot, user: AppUser) => ({ ...snapshot, state: stateForUser(snapshot.state, user), simulation: repository.demoSeed });

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    try {
      let path: string;
      try { path = new URL(request.url ?? '/', 'http://localhost').pathname; } catch { throw new HttpError(400, 'Endereço inválido.'); }
      if (path !== '/api' && !path.startsWith('/api/')) {
        if (!staticDir) throw new HttpError(404, 'Página não encontrada.');
        await serveStatic(request, response, path, staticDir);
        return;
      }
      const origin = request.headers.origin;
      if (origin) {
        const host = request.headers.host;
        if (!allowedOrigins.includes(origin) && origin !== `http://${host}` && origin !== `https://${host}`) throw new HttpError(403, 'Origem não autorizada.');
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        send(response, 204);
        return;
      }
      if (path === '/api/health' && request.method === 'GET') { send(response, 200, { ok: true }); return; }
      if (path === '/api/auth/login' && request.method === 'POST') {
        const body = exactBody(await readBody(request), ['email', 'password']);
        const email = normalizeEmail(body.email);
        if (typeof body.password !== 'string' || !body.password.length || body.password.length > 128) throw new HttpError(400, 'Informe a senha.');
        checkLoginLimit(request.socket.remoteAddress ?? 'unknown', email);
        send(response, 200, repository.login(email, body.password));
        return;
      }
      if (path === '/api/auth/logout' && request.method === 'POST') { repository.logout(bearer(request)); send(response, 204); return; }
      if (path === '/api/auth/me' && request.method === 'GET') { send(response, 200, repository.session(bearer(request))); return; }
      if (path === '/api/state' && request.method === 'GET') {
        const { user } = repository.session(bearer(request));
        send(response, 200, snapshotFor(repository.read(), user));
        return;
      }
      if (path === '/api/commands' && request.method === 'POST') {
        const body = exactBody(await readBody(request), ['command', 'revision']);
        const command = validateCommand(body.command);
        if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0) throw new HttpError(400, 'Informe a revisão dos dados.');
        const { user } = repository.session(bearer(request));
        const result = repository.mutate(({ state }) => {
          authorizeCommand(command, user, state, repository.demoSeed);
          return transition(state, command, new Date(now()).toISOString());
        }, body.revision as number);
        send(response, 200, { ...snapshotFor(result, user), message: result.message });
        return;
      }
      if (path === '/api/users' && request.method === 'POST') {
        const body = exactBody(await readBody(request), ['user'], ['password']);
        const updatedUser = validateUser(body.user);
        const password = body.password === undefined ? undefined : validatePassword(body.password);
        const { user } = repository.session(bearer(request));
        if (user.role !== 'admin') throw new HttpError(403, 'Somente administradores podem gerenciar usuários.');
        const result = repository.mutate(({ state }) => {
          if (!repository.hasCredentials(updatedUser.id) && password === undefined) throw new HttpError(400, 'Defina uma senha para esta conta.');
          const result = transition(state, { type: 'save-user', user: updatedUser }, new Date(now()).toISOString());
          if (result.state !== state && password !== undefined) repository.setPassword(updatedUser.id, password);
          return result;
        });
        send(response, 200, { ...snapshotFor(result, user), message: result.message });
        return;
      }
      throw new HttpError(404, 'Endpoint não encontrado.');
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 429) response.setHeader('Retry-After', '600');
        send(response, error.status, { error: error.message });
      } else {
        // Do not log request bodies, authorization headers, tokens or credentials.
        console.error('Falha interna ao processar a solicitação.');
        send(response, 500, { error: 'Não foi possível concluir a solicitação.' });
      }
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.on('close', () => repository.close());
  return server;
}
