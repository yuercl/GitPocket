# GitPocket

Remote Git Workspace

GitPocket is a remote Git observer for developers who want to inspect server or NAS repositories from phone or desktop. This repo starts with a V1 scaffold:

- `apps/web`: responsive React client for mobile and desktop Git status and diff browsing
- `apps/server`: Fastify API for project registration and Git inspection
- `packages/shared`: shared domain types
- `packages/git-core`: Git access helpers and path safety guards

## Quick start

```bash
pnpm install
pnpm dev:server
pnpm dev:web
```

`apps/web` uses a Vite proxy in development, so the browser can call the Fastify API without hardcoding `localhost` in client code.

## Environment

Server:

```bash
PORT=8788
ALLOWED_REPO_ROOTS=
PROJECTS_FILE=.data/projects.json
```

Web:

```bash
VITE_API_BASE=
```

Leave `VITE_API_BASE` empty when the web app is reverse proxied with the API on the same origin. Set it explicitly only when the frontend must call a different origin.

If `ALLOWED_REPO_ROOTS` is empty, GitPocket trusts all local paths by default. Set it to a comma-separated allowlist only when you want to restrict filesystem access.

Projects are persisted on the server in `PROJECTS_FILE`, so refreshing the browser or opening GitPocket from another browser still shows the saved repo list.
