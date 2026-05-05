# Development Runbook

## Port 3002 Already In Use

If `npm run dev` fails with `EADDRINUSE` on `0.0.0.0:3002`, inspect the listener before restarting:

```bash
lsof -nP -iTCP:3002 -sTCP:LISTEN
```

Stop only the process that is listening on that port:

```bash
kill -TERM <pid>
```

If the process does not exit after a short wait:

```bash
kill -9 <pid>
```

The helper script performs this same port-scoped cleanup and never kills every Node process:

```bash
npm run dev:clean
npm run dev
```

Or clean and start in one command:

```bash
npm run dev:restart
```
