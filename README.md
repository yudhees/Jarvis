# Jarvis

A hands-free voice assistant for one Windows PC. Say **"Hi Jarvis"**, ask for something, and it answers through the speakers. It gets work done through MCP servers (Jira, Slack, GitHub, a browser, Windows control), and it asks for your spoken approval before anything that changes something.

It shows itself as a small animated pet on the desktop that reflects what it is doing: sleeping, listening, thinking, waiting for approval, or speaking.

> **Status:** early. Phase 0 (skeleton, config, mic and speaker tests) is done. Memory, learning, the router, and skill and MCP discovery are built and tested ahead of plan. The voice loop (phase 1) is next. See [CLAUDE.md, section 18](CLAUDE.md#18-status) for details.

## How it works

Two processes talk over a local WebSocket (`127.0.0.1` only, token-protected):

- **core** (Node.js): wake word, recording, speech-to-text, model routing, the agent loop, the permission gate, voice approval, text-to-speech, audit log, hotkeys. Works on its own from a terminal.
- **pet** (Electron): a transparent, always-on-top character. It only displays state and offers convenience controls (stop, mute, quit). It can never approve an action.

Main ideas:

- **Haiku first.** Every request starts on the smallest Claude model and climbs to Sonnet or Opus only when rules, a quick classifier, or the model itself say it is needed.
- **Voice approval in code.** Every tool has a risk tier in `config/permissions.yaml`. Read-only tools run on their own; anything visible to others needs "approve"; high-impact actions need a spoken confirmation code; some things are always blocked. Unlisted tools need approval.
- **Locked-down agent.** The Claude Agent SDK's built-in tools (shell, file editing, web) are turned off. Jarvis only sees tools from its own MCP servers, and each one goes through the gate.
- **Kill switches.** "Jarvis stop", `Ctrl+Alt+J` (stop), and `Ctrl+Alt+M` (mute) work even if the pet is closed.

The full design is in [CLAUDE.md](CLAUDE.md).

## Requirements

- Windows 10 or 11
- Node.js 22.18 or later (runs TypeScript directly, no build step)
- A microphone and speakers (a headset avoids echo during development)
- Later phases: an Anthropic API key and a Picovoice AccessKey, stored in Windows Credential Manager

## Getting started

```bash
npm install
```

```bash
npm run check
```

`check` runs the type checker, the linter (Biome), and the tests.

## Scripts

| Command | What it does |
|---|---|
| `npm run check` | Typecheck, lint, and test |
| `npm test` | Tests only (`node:test`) |
| `npm run format` | Format and fix lint issues |
| `npm run mic-test` | Print live microphone levels. Add `-- --list` to list devices, `-- --device N` to pick one |
| `npm run speaker-test` | Speak a sentence through the Windows voice and core playback. Takes the same flags |
| `npm run learn-repl` | Type to Jarvis's memory, learning, and router. Uses the Claude Memory Store (needs `ANTHROPIC_API_KEY`) |
| `npm run learn-repl -- --local` | Same, with a temporary in-memory store |

## Repository layout

```
config/            models.yaml, permissions.yaml, mcp.yaml, jarvis.yaml (validated at startup)
packages/shared/   event and state types shared by core and pet
packages/core/     audio, tts, router, agent, memory, learning, skills, integrations
packages/pet/      Electron pet (preview/pet-preview.html is a design reference)
scripts/           mic test, speaker test, learning REPL
tests/             unit and guard tests
```

## Configuration

All settings live in `config/*.yaml` and are checked with strict schemas. Unknown keys, bad values, or broken YAML stop startup and list every problem.

- `models.yaml`: which Claude model each tier uses
- `permissions.yaml`: risk tier for each tool
- `mcp.yaml`: which MCP servers to connect
- `jarvis.yaml`: budgets, timeouts, voice, learning, and skill settings

Secrets never go in these files. They belong in Windows Credential Manager.

## Privacy

- Raw audio is never written to disk.
- The audit log is local (`%APPDATA%/jarvis/audit/`), one file per day, deleted after 30 days.
- Memory lives in the Anthropic-hosted Claude Memory Store, not on the PC. Passwords, keys, and card numbers are rejected.

## Roadmap

| Phase | Scope |
|---|---|
| 0 | Skeleton, config, mic and speaker tests (done) |
| 1 | Voice loop: wake word, recording, speech-to-text, Haiku reply, text-to-speech |
| 2 | Router: tiers, speed, escalation |
| 3 | Tools and voice approval, audit log, hard blocks |
| 4 | Desktop pet |
| 5 | Faster, more natural voice: VAD, streaming, barge-in |
| 6 | Windows control, browser, memory and scheduler tools, budget guard |
| 7 | Learning from the user |

Work is tracked as [GitHub issues](https://github.com/yudhees/Jarvis/issues).
