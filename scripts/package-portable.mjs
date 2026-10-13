import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('../.local/portable/index.html', import.meta.url);
const output = new URL('../.local/artifacts/painel-rota.html', import.meta.url);
const html = await readFile(source, 'utf8');
if (/<script\b[^>]*\bsrc\s*=/i.test(html) || /(?:href|src)=["'](?:\.\/)?\/assets\//i.test(html) || /url\(["']?(?:\.\/)?\/assets\//i.test(html)) {
  throw new Error('O HTML portátil ainda contém referências a arquivos externos.');
}
await mkdir(new URL('../.local/artifacts/', import.meta.url), { recursive: true });
await copyFile(source, output);
console.log('Painel portátil:', fileURLToPath(output));
