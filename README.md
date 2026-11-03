# Rabiscadraw

Quadro branco no estilo "desenhado à mão" (clone do Excalidraw). Vite + React + TypeScript + rough.js.

```bash
npm install
npm run dev     # http://127.0.0.1:5173
npm run build
```

## Atalhos
`V` selecionar · `H` mover tela · `R` retângulo · `D` losango · `O` elipse · `A` seta · `L` linha · `P` lápis · `T` texto · `K` laser (só aponta)
`Ctrl+Z` / `Ctrl+Shift+Z` desfazer/refazer · `Ctrl+D` duplicar · `Del` apagar · setas movem a seleção
`Ctrl+scroll` zoom · `Espaço`+arrastar mover tela · duplo clique cria/edita texto · `Shift` mantém proporção / 45°

Salva automaticamente no IndexedDB do navegador, em vários desenhos (barra lateral: criar, renomear, duplicar, apagar e trocar; cada um guarda seu próprio desfazer enquanto a página está aberta). Exporta PNG, SVG e arquivo `.rabiscadraw` (JSON).

## Fontes do texto
Excalifont (a mesma do Excalidraw, licença OFL, em `src/fonts`), Patrick Hand e Nunito. A escolha fica no painel à esquerda e vale para o texto selecionado e para os próximos.

## Logo e ícones
`public/favicon.svg` é a logo; os PNGs (favicon, apple-touch, 192 e 512) e o `manifest.webmanifest` saem dela.

## Componentes de arquitetura
O botão de quadradinhos na barra de ferramentas abre a paleta: banco de dados, cache, storage, servidor, serviço, container, função, worker, load balancer, API gateway, gateways BPMN (exclusivo, paralelo, inclusivo), fila, usuário, web app, mobile, cloud, CDN/DNS, firewall, autenticação, monitoramento, e-mail, busca e arquivo. Estão em `src/catalog.ts` (caminhos SVG desenhados com rough.js). Duplo clique em qualquer forma ou ícone edita a legenda.

## Agentes e IA (botão roxo, canto inferior direito)

### MCP: Claude, Codex e outros agentes
Cada navegador tem um endereço MCP pessoal. O agente desenha no quadro de quem lhe deu o endereço, com a página aberta. Nada é guardado no servidor.

```bash
claude mcp add --transport http rabiscadraw https://<site>/mcp/<seu-token>
```

Ferramentas: `list_components`, `add_diagram`, `get_scene`, `screenshot`, `list_drawings`, `open_drawing`, `clear_drawing`, `delete_elements`.

### IA do próprio servidor (opcional)
Se o servidor tiver `OPENAI_API_KEY`, o painel também desenha a partir de um texto. Em desenvolvimento, copie `.env.example` para `.env` e preencha a chave (e `OPENAI_MODEL`, padrão `gpt-5.6-luna`). A chave fica só no servidor e o `.env` está no `.gitignore`. Em produção o servidor roda **sem** chave: a IA embutida fica desligada e cada pessoa usa o MCP com o próprio agente.

## Produção
`npm run build:all` gera `dist/` (página) e `dist-server/index.mjs` (servidor em um arquivo só). `npm start` sobe o servidor (`PORT`, `HOST`, `ALLOWED_HOSTS`, `STATIC_DIR`; só lê variáveis de ambiente reais, nunca um `.env`).

### Rodar sem acesso ao npm (rede corporativa/VPN)
`dist/` e `dist-server/` já vêm prontos no repositório, com todas as bibliotecas embutidas. Basta Node 20+:

```bash
node dist-server/index.mjs   # http://127.0.0.1:8787
```

Para desenvolver é preciso `npm install` (React, rough.js, MCP SDK, zod, fontes, Vite, TypeScript). O `elkjs` não vem do registro: está copiado em `vendor/elkjs` (licença EPL-2.0) e o `package.json` aponta para essa pasta.

Publicado na Oracle Cloud: veja `docs/DEPLOY-ORACLE.md`. Atualizar o site: `bash scripts/deploy-oracle.sh`.

## Limitações conhecidas
- Os conectores (setas com cantos) não acompanham um item que você mover depois.
- O layout é em camadas (esquerda→direita ou cima→baixo), com uma faixa por grupo.
- Os desenhos ficam no navegador: limpar os dados do site apaga tudo. Use Salvar para fazer backup.
