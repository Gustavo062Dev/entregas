# Publicação do painel

O fluxo `.github/workflows/pages.yml` publica o painel demonstrativo no GitHub Pages depois de cada envio para `main`. O build utiliza o HTML portátil único para manter fontes, ícones e navegação funcionando também no caminho `/entregas/`.

## Ativação inicial

No repositório `Gustavo062Dev/entregas`, abra **Settings → Pages** e selecione **GitHub Actions** em **Build and deployment → Source**. Essa etapa habilita a hospedagem; enviar o código ao GitHub, sozinho, não cria um site ativo.

Se o primeiro workflow rodou antes da ativação, abra **Actions → Publicar painel Rota → Run workflow** e execute em `main`.

O endereço esperado para esse repositório é `https://gustavo062dev.github.io/entregas/`. Só considere a publicação concluída quando o job `deploy` terminar e o endereço abrir o painel.

Em repositório privado, a disponibilidade de Pages depende do plano da conta. Preserve a visibilidade existente do repositório. Se Pages não estiver disponível, use uma hospedagem compatível com site estático.

## O que é publicado

O site contém a demonstração das interfaces administrativas e do entregador. O botão **App do entregador** abre a prévia do app no próprio site. Dados continuam locais ao navegador; esta publicação ainda não conecta o Android ao painel, não autentica usuários nem consulta Alpha7 ou GPS.

Nenhum SDK Android, APK, chave de assinatura, cache ou dependência instalada é enviado pelo workflow do site. Os arquivos publicados são os gerados pelo build em `.local/portable/`.

## Validar antes do envio

```sh
npm ci
npm test
npm run build:portable
```

O workflow utiliza o `package-lock.json`. A infraestrutura Android continua independente da publicação do painel.
