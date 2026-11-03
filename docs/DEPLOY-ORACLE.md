# Rabiscadraw na Oracle Cloud

Publicado em **https://rabiscadraw.SEU-IP.sslip.io** (26/10/2026), na VM `projetos`, ao lado da API do jogo
de abordagens. Sem chave de LLM no servidor: quem desenha é o agente de cada pessoa (Claude, Codex...), por MCP.

---

## 1. Como está montado

```
navegador ──HTTPS──> Caddy (80/443) ──> node dist-server/index.mjs (127.0.0.1:3011)
                                          ├─ serve a página (dist/)
                                          ├─ /bridge/*   liga a página aberta ao servidor
                                          └─ /mcp/<token> endpoint MCP de cada pessoa

agente (Claude/Codex) ──HTTPS──> /mcp/<token> ──> servidor ──> a página dessa pessoa ──> desenha
```

- **Nada fica no servidor.** Os desenhos moram no navegador de cada pessoa (IndexedDB). O servidor só repassa comandos.
- **Sem chave de LLM.** O serviço roda sem `OPENAI_API_KEY`: a IA embutida fica desligada e o painel mostra só a
  conexão MCP. Nenhum `.env` existe na VM e o servidor de produção nem lê arquivo `.env`.
- **Privacidade entre pessoas.** Cada navegador gera um token aleatório (guardado no `localStorage`). O endereço MCP
  é `https://.../mcp/<token>`. Um agente só alcança a página de quem lhe deu aquele endereço. O servidor só aceita
  resposta de comando vinda da mesma sessão que recebeu o comando.
- **A página precisa estar aberta.** O desenho vive no navegador, então o agente só consegue desenhar enquanto a
  aba do Rabiscadraw estiver aberta.

## 2. O que existe na VM [confirmado em 26/10/2026]

| Item | Valor |
| --- | --- |
| VM | `projetos`, `SEU_IP`, Ubuntu 24.04, AMD micro, 1 GB de RAM + 2 GB de swap |
| Usuário SSH | `ubuntu` com a chave `~/.ssh/id_ed25519` |
| Serviço | `rabiscadraw.service` (usuário `apps`, porta `3011`, `MemoryMax=256M`, proteções de systemd) |
| Arquivos | `/srv/apps/rabiscadraw/dist` (página) e `/srv/apps/rabiscadraw/dist-server/index.mjs` (servidor) |
| Caddy | `/etc/caddy/sites/rabiscadraw` (HTTPS automático, Let's Encrypt) |
| Rede | VCN `projetos-vcn`: entrada liberada nas portas 22, 80 e 443. Nada foi alterado na rede. |
| Outros no ar | `abordagens.service` (porta 3001), intacto |
| Consumo | cerca de 70 MB de RAM |

Console da Oracle: https://cloud.oracle.com, conta `marcelomurilotrabalho`, região Brazil East (São Paulo).
As VMs ficam em compartimentos diferentes: `projetos` no compartimento `projetos`, `rejogy-backend` na raiz.

## 3. Atualizar o site

No seu computador, na pasta do projeto:

```bash
bash scripts/deploy-oracle.sh
```

O script gera o build **no seu PC** (a VM tem pouca memória), envia só `dist/` e `dist-server/` e reinicia o serviço.
Seu `.env` local nunca é enviado.

Primeira instalação (já feita): `ssh ubuntu@SEU_IP 'bash -s' < scripts/install-oracle.sh`.
O script é idempotente e recusa instalar se a porta estiver ocupada por outro serviço.

## 4. Operar

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@SEU_IP

systemctl status rabiscadraw
journalctl -u rabiscadraw -f          # logs
sudo systemctl restart rabiscadraw
free -m                               # memória
```

**Desfazer a publicação** (não mexe no jogo):

```bash
sudo systemctl disable --now rabiscadraw
sudo rm /etc/caddy/sites/rabiscadraw /etc/systemd/system/rabiscadraw.service
sudo systemctl daemon-reload && sudo systemctl reload caddy
sudo rm -rf /srv/apps/rabiscadraw
```

## 5. Como uma pessoa conecta o agente dela

1. Abre o site e clica no botão roxo (canto inferior direito).
2. Copia o endereço MCP pessoal (ou o comando pronto).
3. **Claude Code:** `claude mcp add --transport http rabiscadraw https://rabiscadraw.SEU-IP.sslip.io/mcp/<token>`
4. **Codex:** em `~/.codex/config.toml`: `[mcp_servers.rabiscadraw]` e `url = "<endereço>"`. Se a versão não aceitar
   `url`, use `npx -y mcp-remote <endereço>`. [a confirmar com um Codex real]
5. Pede ao agente: "desenhe a arquitetura de ..." com a aba aberta.

Ferramentas: `list_components`, `add_diagram`, `get_scene`, `screenshot`, `list_drawings`, `open_drawing`,
`clear_drawing`, `delete_elements`.

## 6. Segurança do que está publicado

- O endereço MCP é um segredo: quem o tiver desenha no quadro da pessoa. O botão "Gerar um endereço novo" troca o token.
- O servidor só responde para o próprio endereço público (e localhost); outro nome de host recebe 421, origem estranha 403.
- Limites por IP e por token (chamadas por minuto), no máximo 6 abas por token e 400 conexões no total.
- Cabeçalhos de segurança (CSP restritiva, sem iframe, `nosniff`) e proteção contra `..` na entrega de arquivos.
- O token aparece no caminho da URL. O Caddy desta VM não registra caminhos de acesso, e o servidor não imprime URLs.
- Não existe login ainda: o token é a identidade. Isso basta para o uso atual, mas não para dados compartilhados.

## 7. Riscos da Oracle Always Free

- **Instância ociosa pode ser recolhida:** em 7 dias, CPU (percentil 95), rede e, em VMs ARM, memória abaixo de 20%.
  A conta continua sem upgrade para pago, então vale para a VM. A documentação não diz se contas pagas são isentas.
  Fonte: https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm
- **VM de 1 GB é pequena.** Serve para este servidor leve (nada de banco de dados). Se o uso crescer, a cota ARM de
  2 OCPU e 12 GB está livre; criá-la pode falhar com "out of host capacity".
- **Como o desenho fica no navegador, uma queda da VM não perde desenhos.** Só interrompe os agentes.
- Sem upgrade, o console avisa que recursos fora do plano gratuito são removidos.

## 8. Próximos passos (não feitos)

- [ ] Login com Google e GitHub, e desenhos na nuvem (precisa de banco de dados, idealmente na VM ARM).
- [ ] Domínio próprio no lugar do `sslip.io`: aponte um registro `A` para `SEU_IP` e troque o nome em
      `/etc/caddy/sites/rabiscadraw` e em `ALLOWED_HOSTS` no `rabiscadraw.service`.
- [ ] Criar a VM ARM e migrar (basta rodar `install-oracle.sh` e `deploy-oracle.sh` apontando para ela).
- [ ] Testar com um Codex de verdade e ajustar as instruções da seção 5.
- [ ] Escolher a licença do projeto aberto (MIT, por exemplo) e criar o `LICENSE`.
- [ ] Alerta de orçamento no console da Oracle antes de qualquer upgrade para pago.
