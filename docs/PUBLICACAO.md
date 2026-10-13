# Publicação do painel

Existem duas distribuições: a aplicação conectada precisa de um servidor Node e banco persistente; a prévia portátil é estática e pode ser publicada no GitHub Pages.

## Aplicação conectada

Instale Node.js 24, execute `npm ci` e `npm run build`, preencha o `.env` e use `npm start`. O servidor entrega `dist/`, responde a `/api` e mantém o SQLite em `DATABASE_PATH`. Configure o domínio com HTTPS pelo proxy reverso e armazenamento persistente para o banco. Não envie bancos ou credenciais junto dos arquivos estáticos.

O Android usa a URL HTTPS da mesma central, configurada no login ou em `VITE_API_URL` no build. Autorize `https://localhost` em `ROTA_ALLOWED_ORIGINS` para o Capacitor. Veja [configuração completa da API](API.md).

Esta versão foi validada localmente com servidor e sessões independentes; publicar a API em um domínio definitivo e testar em aparelho físico ainda são etapas pendentes. Sites estáticos, incluindo GitHub Pages e a prévia temporária, não executam essa API.

## Prévia no GitHub Pages

O fluxo `.github/workflows/pages.yml` constrói a prévia depois de cada envio para `main` e publica quando o Pages estiver configurado com fonte GitHub Actions. O build utiliza o HTML portátil único para manter fontes, ícones e navegação funcionando também no caminho `/entregas/`.

## Ativação inicial

No repositório `Gustavo062Dev/entregas`, abra **Settings → Pages** e selecione **GitHub Actions** em **Build and deployment → Source**. Essa etapa habilita a hospedagem; enviar o código ao GitHub, sozinho, não cria um site ativo.

Se o primeiro workflow rodou antes da ativação, abra **Actions → Publicar painel Rota → Run workflow** e execute em `main`.

O endereço esperado para esse repositório é `https://gustavo062dev.github.io/entregas/`. Só considere a publicação concluída quando o job `deploy` terminar e o endereço abrir o painel.

Em repositório privado, a disponibilidade de Pages depende do plano da conta. Preserve a visibilidade existente do repositório. Se Pages não estiver disponível, use uma hospedagem compatível com site estático.

## O que é publicado

O site contém a demonstração das interfaces administrativas e do entregador. O botão **App do entregador** abre a prévia do app no próprio site. Nessa distribuição portátil, dados continuam locais ao navegador; ela não usa o login, banco ou API da aplicação conectada, nem consulta Alpha7 ou GPS.

Nenhum SDK Android, APK, chave de assinatura, cache ou dependência instalada é enviado pelo workflow do site. Os arquivos publicados são os gerados pelo build em `.local/portable/`.

## Validar antes do envio

```sh
npm ci
npm test
npm run build:portable
```

O workflow utiliza o `package-lock.json`. A infraestrutura Android continua independente da publicação do painel.
