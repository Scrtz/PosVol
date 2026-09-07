# Posta Volante 📮

> Um endereço de e-mail que existe só o tempo necessário.

E-mail temporário no **seu próprio** domínio, com Cloudflare Email Routing + Workers + D1. Sem servidor pra manter, sem fila de mensagens — o e-mail chega, o Worker escreve no banco, o front-end busca.

**Isso é um template pra você hospedar sozinho — não é um serviço compartilhado.** Cada pessoa que usa esse código sobe a própria cópia, no próprio domínio, no próprio Cloudflare. Ninguém usa a infraestrutura ou o domínio de outra pessoa, então cada instância é responsável pelo próprio abuso/reputação — veja [Segurança e abuso](#segurança-e-abuso).

📖 **Nunca comprou um domínio ou mexeu com Cloudflare Workers? Vai direto pro [`TUTORIAL.md`](TUTORIAL.md)** — passo a passo completo, desde comprar o domínio até o site no ar.

![Tela inicial](docs/screenshots/overview.png)

## Funcionalidades

- Gera endereços `algumacoisa@seudominio.com` na hora
- Expiração configurável (10min / 30min / 1h / 24h) **ou** permanente
- Caixa de entrada com polling automático
- **Conta opcional**: crie um login pra vincular endereços permanentes à sua conta e acessá-los de qualquer aparelho — sem login, endereços permanentes ainda funcionam, só ficam presos ao navegador atual (`localStorage`)
- Modo claro/escuro
- Zero framework no front-end — um `index.html` só, sem build

| Login | Conta ativa |
|---|---|
| ![Login](docs/screenshots/login.png) | ![Logado](docs/screenshots/logged-in.png) |

## Arquitetura

```
┌─────────────────┐         ┌──────────────────────┐         ┌────────────┐
│  E-mail externo  │ ──MX──▶ │  Cloudflare Email     │ ──────▶ │  Worker    │
│  (qualquer um)   │         │  Routing (catch-all)  │         │  email()   │
└─────────────────┘         └──────────────────────┘         └─────┬──────┘
                                                                     │ INSERT
                                                                     ▼
┌─────────────────┐         ┌──────────────────────┐         ┌────────────┐
│  index.html      │ ──────▶ │  Worker fetch()       │ ──────▶ │  D1        │
│  (Pages/estático)│  fetch  │  /api/*                │  SQL   │  (SQLite)  │
└─────────────────┘         └──────────────────────┘         └────────────┘
```

- **Front-end** (`frontend/index.html`): estático, hospedado em Cloudflare Pages (ou qualquer static host). Faz polling em `/api/inbox/:address` a cada poucos segundos.
- **Worker** (`worker/src/index.js`): dois handlers —
  - `email()`: acionado pelo Email Routing a cada mensagem recebida. Rejeita endereços desconhecidos/expirados (`message.setReject`), senão grava em `messages`.
  - `fetch()`: a API REST usada pelo front-end (`/api/generate`, `/api/inbox/:address`, `/api/auth/*`, etc).
  - `scheduled()`: roda de hora em hora, apaga endereços temporários expirados e mensagens antigas — **nunca** toca em endereços permanentes (`expires_at IS NULL`) nem em endereços vinculados a uma conta (`user_id IS NOT NULL`), essa dupla trava é proposital.
- **D1**: três tabelas — `addresses`, `messages`, `users`. Schema completo em [`worker/schema.sql`](worker/schema.sql).

## Autenticação

Sem dependências externas — tudo com Web Crypto, nativo do runtime do Workers:

- Senha: **PBKDF2-SHA256**, 100k iterações, salt aleatório de 16 bytes por usuário. Formato salvo: `iterações:salt_hex:hash_hex`.
- Sessão: token `payload.assinatura` em base64url, assinado com **HMAC-SHA256** (`AUTH_SECRET`). Válido por 90 dias. Mandado pelo front-end como `Authorization: Bearer <token>`.
- Endpoints: `/api/auth/register`, `/api/auth/login`, `/api/auth/me`, `/api/auth/me/addresses`, `/api/auth/claim`.

## Rodando localmente / fazendo deploy

### Pré-requisitos
- Conta Cloudflare com um domínio ativo nela (precisa de DNS na Cloudflare pra usar Email Routing)
- Node.js + `wrangler` (`npm install -g wrangler` ou use o do `worker/package.json`)

### 1. Banco (D1)

```bash
cd worker
npx wrangler d1 create posta-volante
# copia o database_id que aparece pro wrangler.toml
npx wrangler d1 execute posta-volante --file=./schema.sql --remote
```

### 2. Worker

Edita `worker/wrangler.toml`: `database_id`, `MAIL_DOMAIN`, `ALLOWED_ORIGIN`.

```bash
npm install
npx wrangler secret put AUTH_SECRET   # cole uma string aleatória longa
npx wrangler deploy
```

### 3. Email Routing

No dashboard da Cloudflare, no seu domínio → **Email** → **Email Routing**:
- Ativa o Email Routing (ele cuida dos registros MX pra você)
- Em **Rotas**, cria uma regra **catch-all** apontando pra `posta-volante-worker` (o Worker que você acabou de subir)

### 4. Front-end

Edita `frontend/index.html`: troca `API_BASE` pela URL do seu Worker (`https://posta-volante-worker.SEU-SUBDOMINIO.workers.dev`).

Sobe `frontend/index.html` em qualquer host estático — Cloudflare Pages, Netlify, Vercel, GitHub Pages. Não tem build; é o arquivo puro.

## Variáveis de ambiente do Worker

| Nome | Tipo | Descrição |
|---|---|---|
| `MAIL_DOMAIN` | var | domínio onde os endereços temporários são criados |
| `ALLOWED_ORIGIN` | var | origem permitida no CORS (URL do front-end) |
| `RETENTION_HOURS` | var | horas que mensagens de endereços temporários ficam guardadas após o recebimento |
| `AUTH_SECRET` | **secret** | chave que assina os tokens de sessão — `wrangler secret put AUTH_SECRET` |

## Segurança e abuso

Cada deploy usa o domínio e a conta Cloudflare de quem hospeda — não existe domínio ou infraestrutura compartilhada entre instâncias diferentes. Isso significa que quem hospeda também é quem responde pela reputação do próprio domínio. Esse template **não inclui**, de propósito, nada que ajude a espalhar pra estranhos usarem sua instância:

- Sem rate limiting no `/api/generate` — se for expor publicamente, considere adicionar (Cloudflare tem [Rate Limiting Rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) no nível do zone, fora do código do Worker)
- Sem CAPTCHA / proteção contra geração em massa de endereços
- `ALLOWED_ORIGIN` no `wrangler.toml` deve apontar só pro SEU front-end — não deixe como `*` em produção
- O login é opcional e best-effort (sem verificação de e-mail, sem recuperação de senha) — não trate como autenticação de alta segurança

## Limitações conhecidas

- Sem envio de e-mail (só recebimento) — não tem binding `send_email` configurado
- Sem confirmação de e-mail / recuperação de senha no sistema de login (é deliberadamente simples)
- `localStorage` é a única forma de acompanhar endereços sem login

## Licença

MIT — ver [`LICENSE`](LICENSE).
