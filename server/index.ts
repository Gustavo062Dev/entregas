import { createApiServer } from './app.ts';

const port = Number(process.env.PORT ?? '3001');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT deve ser uma porta válida.');
const host = process.env.HOST ?? '127.0.0.1';
try {
  const server = createApiServer();
  server.once('error', () => {
    console.error('Não foi possível abrir a porta da API. Confira HOST e PORT e se outro processo já está usando essa porta.');
    server.close(() => { process.exitCode = 1; });
  });
  server.listen(port, host, () => console.log(`API Rota pronta em ${host}:${port}.`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.close(() => process.exit(0)); });
} catch {
  console.error('Não foi possível iniciar a API. Na primeira execução, configure ROTA_ADMIN_EMAIL e ROTA_ADMIN_PASSWORD (12 a 128 caracteres). Confira também o caminho e as permissões de DATABASE_PATH.');
  process.exitCode = 1;
}
