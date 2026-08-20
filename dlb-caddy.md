# Server Infrastructure Guide

This document explains how we built and operate the server that hosts our applications. It's written for anyone joining the team or needing to understand how deploys work.

## Architecture Overview

Everything runs on a single VPS (Hostinger) using Docker Compose. There is no Kubernetes, no cloud-managed services, no complex orchestration. Each application is its own Docker Compose stack, and a shared Caddy reverse proxy routes traffic to the right container.

```
Internet → Cloudflare (DNS + CDN) → Caddy (TLS + routing) → App containers
```

### Key Components

- **Caddy** — Reverse proxy that handles TLS certificates automatically via Let's Encrypt and routes requests by domain name
- **Docker Compose** — Each app and service is defined in its own `docker-compose.yml`
- **Cloudflare** — DNS and CDN layer in front of everything, set to Full (Strict) SSL mode
- **Watchtower** — Watches for new Docker images on GHCR and auto-restarts containers when updates are available
- **GHCR (GitHub Container Registry)** — Where production app images are stored after CI builds them

### How Containers Talk to Each Other

All containers connect to a shared Docker network called `web`. This is created once on the server:

```sh
docker network create web
```

Every `docker-compose.yml` declares this network as `external: true`. Because they're all on the same network, Caddy can reach any container by its `container_name` — for example, `reverse_proxy staceykawakami-app:80`.

## How We Add a New App

This is the pattern we've followed for every site (see PRs #23, #24 for real examples):

### 1. Set Up the App's Dockerfile and Caddyfile

Each app uses a multi-stage Dockerfile that builds the app and packages it with its own Caddy instance. The app's internal Caddy serves the built files on port 80, and the server's root Caddy reverse-proxies to it.

Here's the standard Dockerfile pattern (static site example):

```dockerfile
FROM node:24-alpine AS deps
RUN npm install -g bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM node:24-alpine AS builder
RUN npm install -g bun
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

FROM caddy:2-alpine AS runner
COPY --from=builder /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]
```

The key is the final stage — `caddy:2-alpine` serves as a lightweight production runtime. The app's own Caddyfile (committed in the app repo, not this infra repo) handles static file serving, security headers, caching, and routing:

```
:80 {
    root * /srv
    encode gzip

    header {
        Content-Security-Policy "default-src 'self'; style-src 'self' 'unsafe-inline'; ..."
        Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
    }

    try_files {path} {path}/index.html
    file_server

    # Long-lived cache for hashed assets
    header /_assets/* Cache-Control "public, max-age=31536000, immutable"

    # Block dotfiles
    @dotfiles path_regexp \/\.
    respond @dotfiles 404

    handle_errors {
        rewrite * /404.html
        file_server
    }
}
```

Notice the app Caddyfile listens on `:80` (plain HTTP). TLS is handled by the server's root Caddy, not the app. This keeps the app container simple and portable.

For apps with a backend API (like the-innovation-lab), the app's Caddyfile also reverse-proxies `/api/*` routes to the backend process running inside the same container.

### 2. Set Up CI in the App Repo

The app repo has a GitHub Actions workflow that builds a Docker image and pushes it to GHCR on every push to `main`:

```yaml
# Builds and pushes to ghcr.io/<org>/<app>/app:latest
- uses: docker/build-push-action@v6
  with:
    push: true
    tags: |
      ghcr.io/<org>/<app>/app:latest
      ghcr.io/<org>/<app>/app:${{ env.TAG }}
```

The `:latest` tag is important — Watchtower watches for new digests under this tag to trigger auto-updates.

### 2. Create a Docker Compose File

In this repo, create `apps/<app-name>/docker-compose.yml`:

```yaml
services:
  app:
    image: ghcr.io/<org>/<app>/app:${IMAGE_TAG:-latest}
    container_name: <app-name>-app
    restart: unless-stopped
    networks:
      - web
    labels:
      com.centurylinklabs.watchtower.enable: "true"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

networks:
  web:
    external: true
```

Key points:
- `container_name` must be unique and is what Caddy uses to route traffic
- The Watchtower label opts this container into auto-updates
- The `web` network connects it to Caddy

### 3. Add a Caddy Route

Add a site block to `Caddyfile`:

```
yourdomain.com {
    reverse_proxy <app-name>-app:80
}
```

That's it. Caddy automatically provisions a Let's Encrypt TLS certificate for the domain.

### 4. Set Up DNS

In Cloudflare, add an A record for the domain pointing to the server's IP. Set SSL mode to **Full (Strict)** — this requires a valid cert on the origin, which Caddy handles automatically.

### 5. Deploy

```sh
# Start the app
docker compose -f apps/<app-name>/docker-compose.yml up -d

# Restart Caddy to pick up the new route
docker compose restart caddy
```

After this, Watchtower handles all future deploys automatically — every time CI pushes a new `:latest` image to GHCR, Watchtower detects it within 5 minutes and restarts the container with the new image.

## How Auto-Deploy Works (Watchtower)

Watchtower runs as its own Docker Compose stack and polls GHCR every 5 minutes. It only watches containers that have the label:

```yaml
labels:
  com.centurylinklabs.watchtower.enable: "true"
```

The flow:

1. Developer pushes to `main` in an app repo
2. GitHub Actions builds a new Docker image and pushes it to GHCR as `:latest`
3. Watchtower detects the new image digest (within 5 minutes)
4. Watchtower pulls the new image, stops the old container, and starts a new one
5. Zero manual intervention required

**Important:** This only works with mutable tags like `latest`. If you pin to an immutable tag (like a commit SHA), Watchtower will never find updates. We learned this the hard way (see PR #15).

## How Staging Works

We have two patterns for staging environments depending on the app:

### Pattern 1: Registry-Based Staging (e.g., the-innovation-lab)

For apps with CI pipelines that build staging images, staging works just like production but with a different image tag and subdomain:

- CI builds and pushes a `staging`-tagged image to GHCR
- A separate `docker-compose.yml` references the staging image
- Watchtower auto-updates it the same way as production
- Caddy routes the staging subdomain to the staging container

### Pattern 2: Locally-Built Staging with Password Protection (e.g., staceykawakami)

For apps where we want to manually control when staging updates (no CI for the staging branch), we build the Docker image locally on the server:

```sh
# Check out the staging branch and build locally
cd ~/c0de/<app-name> && git checkout staging && git pull
docker build -t <app-name>-staging:latest .

# Start the container
docker compose -f /srv/apps/<app-name>-staging/docker-compose.yml up -d
```

The compose file references the local image (no GHCR):

```yaml
services:
  app:
    image: <app-name>-staging:latest    # local image, not a registry
    container_name: <app-name>-staging-app
    restart: unless-stopped
    networks:
      - web
    # No Watchtower label — manual deploys only
```

To rebuild after changes to the staging branch, just re-run the build and restart:

```sh
cd ~/c0de/<app-name> && git pull
docker build -t <app-name>-staging:latest .
docker compose -f /srv/apps/<app-name>-staging/docker-compose.yml up -d
```

### Password-Protecting Staging Sites

Staging sites are protected with HTTP Basic Auth at the Caddy level. This means the app itself doesn't need any authentication logic — Caddy gates all requests before they reach the container.

In the Caddyfile:

```
staging.yourdomain.com {
    basic_auth {
        <username> <bcrypt-hash>
    }
    reverse_proxy <app-name>-staging-app:80
}
```

To generate a bcrypt hash for a password:

```sh
docker run --rm caddy:2-alpine caddy hash-password --plaintext '<your-password>'
```

Then paste the hash into the Caddyfile and restart Caddy. Stick to alphanumeric passwords — special characters can cause issues with some browsers' Basic Auth prompts.

## TLS and Cloudflare

Caddy handles TLS certificates automatically. There are two rules we learned from production incidents (documented in PR #12 and PR #14):

1. **Never use `auto_https off`** — This disables Caddy's HTTPS listener entirely. Cloudflare expects to connect on port 443, so this causes 522 errors (connection refused).

2. **Never use `tls internal`** — This generates self-signed certs. Cloudflare Full (Strict) mode rejects self-signed certs with 526 errors.

Just use bare domain site blocks and let Caddy handle everything:

```
yourdomain.com {
    reverse_proxy app:80
}
```

## Observability with Grafana

We run a shared observability stack for monitoring and debugging applications. It lives in `observability/` and runs as its own Docker Compose stack:

```sh
docker compose -f observability/docker-compose.yml up -d
```

The stack consists of:

- **Grafana** — Dashboards and visualization, accessible at `grafana.theinnovationlab.dev`
- **Prometheus** — Metrics collection and storage
- **Loki** — Log aggregation
- **Tempo** — Distributed tracing
- **OpenTelemetry (OTEL) Collector** — Receives telemetry from apps and routes it to the right backend

### How Apps Send Telemetry

Apps on the `web` network can send traces, metrics, and logs to the OTEL Collector via OTLP HTTP on port 4318. The collector then fans out to Prometheus (metrics), Loki (logs), and Tempo (traces).

```
App → OTEL Collector (port 4318) → Prometheus (metrics)
                                  → Loki (logs)
                                  → Tempo (traces)
                                  → Grafana (visualizes all three)
```

To wire up an app, add the collector URL to its environment:

```yaml
environment:
  OTEL_COLLECTOR_URL: ${OTEL_COLLECTOR_URL:-http://otel-collector:4318}
```

### Grafana Data Sources

Grafana comes pre-configured with provisioned data sources (defined in `observability/grafana/datasources.yml`):

- Prometheus for metrics
- Loki for logs
- Tempo for traces

These are cross-linked so you can jump from a trace to its logs or from metrics to related traces.

### Access

Grafana is password-protected with an admin password set via `GF_SECURITY_ADMIN_PASSWORD` in `observability/.env`. It's exposed through Caddy at `grafana.theinnovationlab.dev` — no basic_auth needed since Grafana has its own login.

## Secrets

`.env` files contain database credentials, API keys, and other secrets. They live alongside each app's `docker-compose.yml` but are git-ignored at every level. When setting up a new app, you create the `.env` manually on the server.

## Directory Structure

```
/srv
├── docker-compose.yml              # Root Caddy reverse proxy
├── Caddyfile                       # All routing rules
├── apps/
│   ├── the-innovation-lab/         # Production app (GHCR + Watchtower)
│   ├── davidlbowman/              # Production app (GHCR + Watchtower)
│   ├── staceykawakami/            # Production app (GHCR + Watchtower)
│   ├── staceykawakami-staging/    # Staging (local build, password-protected)
│   └── spotify-pomodoro/          # Production app (GHCR + Watchtower)
├── observability/
│   ├── docker-compose.yml          # Grafana, Prometheus, Loki, Tempo, OTEL Collector
│   ├── otel-collector-config.yaml
│   ├── prometheus.yml
│   ├── loki-config.yaml
│   ├── tempo-config.yaml
│   └── grafana/
│       └── datasources.yml         # Provisioned Grafana data sources
└── watchtower/
    └── docker-compose.yml          # Auto-update service
```

## Quick Reference

| Task | Command |
|------|---------|
| Start an app | `docker compose -f apps/<name>/docker-compose.yml up -d` |
| View logs | `docker compose -f apps/<name>/docker-compose.yml logs -f` |
| Restart Caddy | `docker compose restart caddy` |
| Rebuild staging | `cd ~/c0de/<app> && git pull && docker build -t <app>-staging:latest .` |
| Hash a password | `docker run --rm caddy:2-alpine caddy hash-password --plaintext '<pass>'` |
| Check running containers | `docker ps` |
