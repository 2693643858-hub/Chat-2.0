# Codex Chat Deployment

This project is a single Node.js service. It serves the static frontend, REST APIs, WebSocket realtime chat, and SQLite database.

## Production Shape

- Runtime: Node.js 24+
- Web process: `npm start`
- Health check: `GET /api/health`
- Persistent data directory: `DATA_DIR`
- SQLite database path: `$DATA_DIR/chat.sqlite`
- Local fallback email outbox: `$DATA_DIR/outbox`

## Required Environment Variables

```env
NODE_ENV=production
PORT=3000
DATA_DIR=/data
APP_URL=https://your-domain.example
SEED_DEMO_USERS=false
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your@email.com
SMTP_PASS=your-smtp-password
SMTP_FROM=Codex Chat <your@email.com>
SMTP_SECURE=false
SMTP_STARTTLS=true
```

`APP_URL` must be the public HTTPS URL of the app. Email verification links use this value.

`SMTP_*` must be configured before public launch. Without SMTP, verification emails are written into `$DATA_DIR/outbox`, which is only useful for local testing.

## Local Docker Test

```bash
docker build -t codex-chat .
docker run --rm -p 3000:3000 \
  -e APP_URL=http://localhost:3000 \
  -e SEED_DEMO_USERS=true \
  -v codex-chat-data:/data \
  codex-chat
```

Open:

```text
http://localhost:3000
```

## Render/Fly-style Deployment Checklist

1. Push this folder to GitHub.
2. Create a Web Service from the repository.
3. Use Docker deployment.
4. Mount a persistent disk or volume at `/data`.
5. Set the environment variables from `.env.example`.
6. Set health check path to `/api/health`.
7. Bind your custom domain.
8. Set `APP_URL` to the final `https://...` domain.
9. Register a new user and confirm the email.
10. Test WebSocket messaging in two browsers or two accounts.

## Important Production Notes

- SQLite with one Node process is fine for a small public beta.
- Do not run multiple app instances with the same SQLite file.
- For larger usage, migrate the database to PostgreSQL and use Redis pub/sub for WebSocket broadcast across instances.
- Back up `$DATA_DIR/chat.sqlite` regularly.
- Keep `SEED_DEMO_USERS=false` in production.

## Netlify Frontend Deployment

Netlify can host the static frontend. The recommended public setup is now:

- Netlify: static frontend
- Supabase Auth: email registration and confirmation
- Supabase Postgres: profiles, friends, conversations, messages
- Supabase Realtime: live message updates

The included `netlify.toml` fixes the common Netlify 404 by publishing the `public` directory:

```toml
[build]
  command = "npm run build:netlify"
  publish = "public"
```

## Supabase Backend Setup

1. Create a Supabase project.
2. Open **SQL Editor**.
3. Copy and run [supabase/schema.sql](./supabase/schema.sql).
4. Open **Authentication > URL Configuration**.
5. Set **Site URL** to your Netlify URL, for example:

```text
https://chat-tex.netlify.app
```

6. Add the same URL to **Redirect URLs**.
7. Open **Project Settings > API** and copy:
   - Project URL
   - anon public key
8. In Netlify, set these environment variables:

```env
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your-supabase-anon-key
```

Then redeploy the Netlify site.

After this, registration sends Supabase's email confirmation message automatically. You no longer need the old Node SMTP backend for the Netlify + Supabase version.

If the page says Supabase is not configured, check that the Netlify environment variables above are set for the production context and redeploy.

## Legacy Node Backend Email

The Docker/Node backend still supports SMTP if you deploy it separately. This is not required for the Netlify + Supabase setup above because Supabase Auth sends confirmation emails.

### QQ Mail SMTP Example

For `@qq.com` sender accounts, first enable POP3/SMTP or IMAP/SMTP in QQ Mail settings and generate an authorization code. Use that authorization code as `SMTP_PASS`; do not use your normal QQ password.

```env
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_USER=2693643858@qq.com
SMTP_PASS=your-qq-mail-authorization-code
SMTP_FROM=Codex Chat <2693643858@qq.com>
SMTP_SECURE=true
SMTP_STARTTLS=false
```

If you prefer port `587`, use STARTTLS instead:

```env
SMTP_HOST=smtp.qq.com
SMTP_PORT=587
SMTP_USER=2693643858@qq.com
SMTP_PASS=your-qq-mail-authorization-code
SMTP_FROM=Codex Chat <2693643858@qq.com>
SMTP_SECURE=false
SMTP_STARTTLS=true
```
