import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

// Fail before starting either process when the API port is occupied.
const port = Number(process.env.PORT || 3001);
if (port !== 3001) throw new Error('O proxy de desenvolvimento usa PORT=3001. Ajuste vite.config.ts para usar outra porta.');
await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});

const api = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development' } });
const ui = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0'], { stdio: 'inherit' });
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  api.kill('SIGTERM');
  ui.kill('SIGTERM');
  process.exitCode = code;
}
api.once('exit', code => stop(code ?? 1));
ui.once('exit', code => stop(code ?? 1));
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
