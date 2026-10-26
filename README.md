# Rabiscadraw

Quadro branco no estilo "desenhado à mão" (clone do Excalidraw). Vite + React + TypeScript + rough.js.

```bash
npm install
npm run dev     # http://localhost:5173
npm run build
```

## Atalhos
`V` selecionar · `H` mover tela · `R` retângulo · `D` losango · `O` elipse · `A` seta · `L` linha · `P` lápis · `T` texto · `K` laser (só aponta)
`Ctrl+Z` / `Ctrl+Shift+Z` desfazer/refazer · `Ctrl+D` duplicar · `Del` apagar · setas movem a seleção
`Ctrl+scroll` zoom · `Espaço`+arrastar mover tela · duplo clique cria/edita texto · `Shift` mantém proporção / 45°

Salva automaticamente no IndexedDB do navegador. Exporta PNG, SVG e arquivo `.rabiscadraw` (JSON).

## Fontes do texto
Excalifont (a mesma do Excalidraw, licença OFL, em `src\fonts`), Patrick Hand e Nunito. A escolha fica no painel à esquerda e vale para o texto selecionado e para os próximos.

## Logo e ícones
`public/favicon.svg` é a logo; os PNGs (favicon, apple-touch, 192 e 512) e o `manifest.webmanifest` saem dela.
