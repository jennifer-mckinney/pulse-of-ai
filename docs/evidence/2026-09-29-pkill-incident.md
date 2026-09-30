# Incident: pattern-based pkill during the collectors demo (2026-09-29)

## What was run
At about 2026-09-28 20:31 PDT (2026-09-29 03:31 UTC), right after commit
c8d2aa5, the collectors agent (worktree `.claude/worktrees/agent-a322de0c65a978409`,
branch `feature/source-collectors`) ran, on the host:

```
pkill -f "node src/workers/start.js" ; pkill -f "node src/server.js"
```

The intent was to stop the two processes that agent had started for the local
end-to-end demo:
- `node src/workers/start.js`, started with `POSTGRES_DB=pulse_of_ai_collect_demo REDIS_DB=7`
- `node src/server.js`, started with `PORT=3400 POSTGRES_DB=pulse_of_ai_collect_demo REDIS_DB=7`

Both were started with `nohup ... &` from the worktree above, and their PIDs
were NOT recorded. Pattern matching (`-f`) matches ANY host process whose
command line contains those strings, whatever its checkout. It should never
have been used.

## What it matched and killed
**It cannot be determined exactly.** pkill logs nothing, no process list was
taken before it ran, and there is no process accounting on this host. What is
known:

- **Certainly killed:** the agent's own demo worker and demo web server
  (worktree above; web on port 3400). PIDs not recorded.
- **Possibly killed: the session worktree's preview dev server.** The session
  worktree (a separate checkout of this repository, `<projects-dir>/pulse-of-ai/sweet-driscoll-118bbf`)
  has a `.claude/launch.json` config "Express API (dev)" = `npm run dev` on
  port 3000, which runs `node src/server.js`, so its command line matches the
  second pattern. The coordinator reports that its preview server ran on
  port 3000. After the pkill, nothing listens on 3000 and no `npm run dev`
  process exists. Nothing was checked on 3000 before the pkill, so it is
  unknown whether that server was still running at 03:31 UTC. If it was, this
  command killed it. `npm run dev` exits when its child dies, which would
  explain why neither remains. Jennifer's main checkout has the same
  launch.json, so the same applies if a dev server from there was running on
  the host at that time.
- **Not affected:**
  - Docker containers: the dev stack (`pulse-of-ai-*`), the
    `pulse-of-ai-standup-test5-*` stack and srs-ai-assist (`srs-qdrant`,
    `srs-neo4j`). On macOS their processes run inside the Docker VM, where a
    host pkill cannot reach them. All were still up afterwards (`docker ps`).
  - The `pulse-of-ai-standup-test4` stack (localhost:3200) was not running
    at the start of this session (absent from `docker ps` then).
  - The only node/npm processes left on the host are MCP servers
    (desktop-commander, server-pdf) and a CI runner (`RunnerService.js`), none
    of which matches either pattern.

## Summary
| Process | Checkout | Killed? |
|---|---|---|
| demo worker `node src/workers/start.js` | agent-a322de0c65a978409 | yes (own) |
| demo web `node src/server.js` :3400 | agent-a322de0c65a978409 | yes (own) |
| preview dev server `node src/server.js` :3000 | sweet-driscoll-118bbf (session worktree) | unknown: killed if it was running |
| any host `node src/server.js` / worker from Jennifer's main checkout | main checkout | unknown: none was observed; killed if one was running |
| srs-ai-assist | Docker | no |
| Docker stacks (dev, test5) | Docker | no |

Nothing was restarted.

## Rule adopted
Stop only processes this agent started, by recorded PID or by port. Never
use a pattern-based `pkill` or `killall`.
