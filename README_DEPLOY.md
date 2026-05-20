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
