# relay

A multi-agent harness for the `claude` CLI, with a full-screen TUI.

- **Opus leads.** It reads the repo, splits the goal into tasks with dependencies, then reviews and verifies the results. It can run follow-up rounds.
- **Haiku swarms.** Workers run the tasks in parallel, each as its own `claude -p` process.
- **Opus on call.** Every worker has an `escalate_to_opus` tool. A worker that gets stuck hands the problem up: `advise` gets read-only guidance back, `delegate` has Opus do the work. Each escalation shows up live in the diagram.
- **A report for every run.** Each run leaves `.relay/runs/<time>/report.md`, `run.json` and the raw stream-json of every agent.

```
relay                                  # interactive: type tasks in the TUI
relay "add input validation to api/"   # start right away
relay --mock                           # simulated agents, no tokens spent
relay --plain "task"                   # log lines only (CI / pipes)
```

## How it works

```
             ┌──────── Opus · lead ────────┐   plan  (--json-schema, read-only tools)
             └──────────────┬──────────────┘
          ┌─────────────────┼─────────────────┐
     Haiku worker      Haiku worker      Haiku worker     claude -p, in parallel, DAG order
          │ escalate_to_opus (MCP tool)
          └──► unix socket ──► relay ──► Opus  (advise: read-only / delegate: full)
          └─────────────────┬─────────────────┘
             ┌──── back to Opus · lead ────┐   review + verify → done | follow-up round
             └─────────────────────────────┘
```

- `src/orchestrator.js` runs plan → execute → review. It also runs the unix-socket server that takes escalations and launches them as agents.
- `src/escalate-mcp.js` is a stdio MCP server with no dependencies. Each worker gets it through `--mcp-config` and it forwards `escalate_to_opus` calls over the socket.
- `src/agent.js` spawns `claude -p --output-format stream-json` and parses the events into state.
- `src/tui.js` and `src/canvas.js` hold the renderer: a truecolor cell buffer that redraws only the rows that changed.

## Options

| flag | default | |
|---|---|---|
| `--lead / --worker / --escalate <model>` | opus / haiku / opus | any `--model` value |
| `--effort <level>` | high | lead + escalations |
| `-j, --concurrency <n>` | 4 | parallel workers |
| `--rounds <n>` | 3 | max plan/review rounds |
| `--max-tasks <n>` | 8 | per round |
| `--max-escalations <n>` | 6 | per run |
| `--budget <usd>` | none | stops dispatching once spend passes this; each agent also gets `--max-budget-usd` |
| `--permission-mode <m>` | acceptEdits | for workers |
| `--allow <rule>` | | repeatable, e.g. `--allow "Bash(npm test:*)"`. Also gives the reviewer Bash |
| `--yolo` | off | bypassPermissions for workers (sandboxes only) |
| `--inherit-mcp` | off | agents load your MCP servers (by default they are isolated, which is faster) |
| `-C, --cwd`, `--out`, `--keep-sessions`, `--plain`, `--mock` | | |

Workers can edit files without asking (`acceptEdits`), but shell commands are denied unless you allow them with `--allow`. Without that, nobody can run tests. Typical usage:

```
relay --allow "Bash(npm test:*)" --allow "Bash(git diff:*)" "fix the flaky auth tests"
```

## Keys

`tab`/arrows select the lead, a worker or an escalation · `enter` starts the typed task or opens the selected agent's transcript (↑↓ PgUp/PgDn g/G, esc to go back) · `q` aborts the run · `ctrl-c` aborts, then quits.

At least 100×30 is recommended. Below that the layout shrinks step by step and pages through worker rows.
