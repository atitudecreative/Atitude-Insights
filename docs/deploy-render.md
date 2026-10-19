# Implantação: Render + Supabase

## 1. Supabase — qual connection string usar

No painel do projeto, clique em **Connect** (topo da página). Aparecem três opções:

| Opção | Formato | Usar? |
|---|---|---|
| Direct connection | `postgresql://postgres:[SENHA]@db.<ref>.supabase.co:5432/postgres` | **Não** — só funciona por IPv6, e o Render não tem saída IPv6 |
| Transaction pooler | `postgresql://postgres.<ref>:[SENHA]@aws-0-<região>.pooler.supabase.com:6543/postgres` | possível, mas não necessário |
| **Session pooler** | `postgresql://postgres.<ref>:[SENHA]@aws-0-<região>.pooler.supabase.com:5432/postgres` | **Sim** — use esta para tudo (aplicação, migrações, cron) |

* Substitua `[SENHA]` pela senha do banco (Project Settings → Database → Reset database password, se não souber).
* Se a senha tiver caracteres especiais (`@ # / ? %`), codifique-os (ex.: `@` → `%40`) ou gere uma senha só com letras e números.
* Acrescente `?sslmode=require` ao final.

Exemplo final:

```
postgresql://postgres.abcdefghijkl:MinhaSenha123@aws-0-sa-east-1.pooler.supabase.com:5432/postgres?sslmode=require
```

### Sobre a integração GitHub do Supabase

Ela aplica apenas migrações da pasta `supabase/migrations`. Este projeto usa
`db/migrations` e um executor próprio, então essa integração não cria nada no
banco — as migrações são aplicadas pelo Render a cada deploy (passo 2). Pode
mantê-la ou desconectá-la; não interfere.

## 2. Render — Blueprint

O arquivo `render.yaml` cria dois serviços:

* **atitude-insights** (Web Service): build, migrações automáticas antes de cada
  deploy (`preDeployCommand`) e a aplicação.
* **atitude-insights-sync** (Cron Job): roda `npm run sync:once` a cada 15
  minutos — enfileira e processa as sincronizações do Asana e da Meta.

Passos:

1. Render → **New → Blueprint** → conecte o repositório e escolha a branch.
2. Preencha as variáveis pedidas:

   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` | Session pooler do Supabase (acima) |
   | `APP_URL` | `https://atitude-insights.onrender.com` (ou seu domínio) — sem barra no final |
   | `ENCRYPTION_KEY` | gere com `openssl rand -base64 32` e **guarde uma cópia segura** |
   | `META_APP_ID`, `META_APP_SECRET`, `ASANA_CLIENT_ID`, `ASANA_CLIENT_SECRET` | deixe em branco por enquanto (opcionais) |

   `CRON_SECRET` é gerado automaticamente.
3. Clique em **Apply**. O primeiro deploy roda as migrações e publica o site.
4. Crie o superadministrador: no serviço web, abra **Shell** e rode

   ```bash
   npm run db:seed-admin -- seu@email.com "Seu Nome"
   ```

   (digite a senha quando pedir — mínimo 10 caracteres, com letras e números).
5. Acesse `APP_URL/login`.

Sem acesso a gerar a chave no terminal? No Shell do Render rode
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

### Planos e custos

* `preDeployCommand` e serviços sem hibernação exigem plano pago (Starter).
* No plano **Free** o site hiberna após inatividade e não há Cron Job. Para
  testar no Free: mude `plan: free`, remova `preDeployCommand`, rode
  `npm run db:migrate` pelo Shell e use um agendador externo gratuito
  (cron-job.org) chamando `POST https://SEU_APP/api/cron/sync` com o cabeçalho
  `Authorization: Bearer <CRON_SECRET>` a cada 15 minutos.

### Domínio próprio

Render → serviço web → **Settings → Custom Domains**. Depois atualize `APP_URL`
e as URIs de callback dos apps Asana/Meta.

## 3. Verificação

* `https://SEU_APP/api/health` deve responder `{"ok":true}`.
* Logs do Cron Job mostram `[sync] enfileirados=… processados=…`.

## Observações

* O Render não tem região no Brasil. Se o Supabase estiver em São Paulo, use
  `virginia` ou `ohio` no Render (latência aceitável); para menor latência, crie
  o Supabase em `us-east-1`.
* O Shell do Render só existe nos planos pagos. No Free, rode `db:migrate` e
  `db:seed-admin` do seu computador com `DATABASE_URL` apontando para o Session
  pooler.
