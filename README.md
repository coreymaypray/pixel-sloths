<h1 align="center">
    <img src="webview-ui/public/banner.png" alt="Pixel Sloths">
</h1>

<h2 align="center" style="padding-bottom: 20px;">
  Sloth-themed pixel art office where your Claude Code agents come to life — by Cyber Sloth Empire
</h2>

<div align="center" style="margin-top: 25px;">

[![license](https://img.shields.io/github/license/coreymaypray/pixel-sloths?color=0183ff&style=flat)](https://github.com/coreymaypray/pixel-sloths/blob/main/LICENSE)

</div>

<br/>

> **Fork of [Pixel Sloths](https://github.com/coreymaypray/pixel-sloths)** by Pablo De Lucca. Rebranded as **Pixel Sloths** for the Cyber Sloth Empire.

Pixel Sloths turns multi-agent AI systems into something you can actually see and manage. Each agent becomes an animated sloth character in a pixel art office. They walk around, sit at their desk, and visually reflect what they are doing — typing when writing code, reading when searching files, waiting when it needs your attention.

Right now it works as a VS Code extension with Claude Code.

![Pixel Sloths screenshot](webview-ui/public/Screenshot.jpg)

## Features

- **One agent, one character** — every Claude Code terminal gets its own animated character
- **Live activity tracking** — characters animate based on what the agent is actually doing (writing, reading, running commands)
- **Office layout editor** — design your office with floors, walls, and furniture using a built-in editor
- **Speech bubbles** — visual indicators when an agent is waiting for input or needs permission
- **Sound notifications** — optional chime when an agent finishes its turn
- **Sub-agent visualization** — Task tool sub-agents spawn as separate characters linked to their parent
- **Persistent layouts** — your office design is saved and shared across VS Code windows
- **Diverse characters** — 6 diverse characters. These are based on the amazing work of [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack).

<p align="center">
  <img src="webview-ui/public/characters.png" alt="Pixel Sloths characters" width="320" height="72" style="image-rendering: pixelated;">
</p>

## Requirements

- VS Code 1.105.0 or later
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and configured

## Getting Started

If you want to play with the code, develop, or contribute:

### Install from source

```bash
git clone https://github.com/coreymaypray/pixel-sloths.git
cd pixel-sloths
npm install
cd webview-ui && npm install && cd ..
npm run build
```

Then press **F5** in VS Code to launch the Extension Development Host.

### Usage

1. Open the **Pixel Sloths** panel (it appears in the bottom panel area alongside your terminal)
2. Click **+ Agent** to spawn a new Claude Code terminal and its character
3. Start coding with Claude — watch the character react in real time
4. Click a character to select it, then click a seat to reassign it
5. Click **Layout** to open the office editor and customize your space

## Layout Editor

The built-in editor lets you design your office:

- **Floor** — Full HSB color control
- **Walls** — Auto-tiling walls with color customization
- **Tools** — Select, paint, erase, place, eyedropper, pick
- **Undo/Redo** — 50 levels with Ctrl+Z / Ctrl+Y
- **Export/Import** — Share layouts as JSON files via the Settings modal

The grid is expandable up to 64×64 tiles. Click the ghost border outside the current grid to grow it.

### Office Assets

All office assets (furniture, floors, walls) are now **fully open-source** and included in this repository under `webview-ui/public/assets/`. No external purchases or imports are needed — everything works out of the box.

Each furniture item lives in its own folder under `assets/furniture/` with a `manifest.json` that declares its sprites, rotation groups, state groups (on/off), and animation frames. Floor tiles are individual PNGs in `assets/floors/`, and wall tile sets are in `assets/walls/`. This modular structure makes it easy to add, remove, or modify assets without touching any code.

To add a new furniture item, create a folder in `webview-ui/public/assets/furniture/` with your PNG sprite(s) and a `manifest.json`, then rebuild. The asset manager (`scripts/asset-manager.html`) provides a visual editor for creating and editing manifests.

Detailed documentation on the manifest format and asset pipeline is coming soon.

Characters are based on the amazing work of [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack).

## How It Works

Pixel Sloths watches Claude Code's JSONL transcript files to track what each agent is doing. When an agent uses a tool (like writing a file or running a command), the extension detects it and updates the character's animation accordingly. No modifications to Claude Code are needed — it's purely observational.

The webview runs a lightweight game loop with canvas rendering, BFS pathfinding, and a character state machine (idle → walk → type/read). Everything is pixel-perfect at integer zoom levels.

## Tech Stack

- **Extension**: TypeScript, VS Code Webview API, esbuild
- **Webview**: React 19, TypeScript, Vite, Canvas 2D

## Known Limitations

- **Agent-terminal sync** — the way agents are connected to Claude Code terminal instances is not super robust and sometimes desyncs, especially when terminals are rapidly opened/closed or restored across sessions.
- **Heuristic-based status detection** — Claude Code's JSONL transcript format does not provide clear signals for when an agent is waiting for user input or when it has finished its turn. The current detection is based on heuristics (idle timers, turn-duration events) and often misfires — agents may briefly show the wrong status or miss transitions.
- **Windows-only testing** — the extension has only been tested on Windows 11. It may work on macOS or Linux, but there could be unexpected issues with file watching, paths, or terminal behavior on those platforms.

## Where This Is Going

The long-term vision is an interface where managing AI agents feels like playing the Sims, but the results are real things built.

- **Agents as characters** you can see, assign, monitor, and redirect, each with visible roles (designer, coder, writer, reviewer), stats, context usage, and tools.
- **Desks as directories** — drag an agent to a desk to assign it to a project or working directory.
- **An office as a project** — with a Kanban board on the wall where idle agents can pick up tasks autonomously.
- **Deep inspection** — click any agent to see its model, branch, system prompt, and full work history. Interrupt it, chat with it, or redirect it.
- **Token health bars** — rate limits and context windows visualized as in-game stats.
- **Fully customizable** — upload your own character sprites, themes, and office assets. Eventually maybe even move beyond pixel art into 3D or VR.

For this to work, the architecture needs to be modular at every level:

- **Platform-agnostic**: VS Code extension today, Electron app, web app, or any other host environment tomorrow.
- **Agent-agnostic**: Claude Code today, but built to support Codex, OpenCode, Gemini, Cursor, Copilot, and others through composable adapters.
- **Theme-agnostic**: community-created assets, skins, and themes from any contributor.

We're actively working on the core module and adapter architecture that makes this possible. If you're interested to talk about this further, please visit our [Discussions Section](https://github.com/coreymaypray/pixel-sloths/discussions).


## Community & Contributing

We use **[GitHub Discussions](https://github.com/coreymaypray/pixel-sloths/discussions)** for questions, feature ideas, and conversations. **[Issues](https://github.com/coreymaypray/pixel-sloths/issues)** are for bug reports only.

If something is broken, open an issue. For everything else, start a discussion.

See [CONTRIBUTING.md](CONTRIBUTING.md) for instructions on how to contribute.

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Credits

Forked from [Pixel Agents](https://github.com/pablodelucca/pixel-agents) by Pablo De Lucca. Consider [sponsoring the original project](https://github.com/sponsors/pablodelucca).

## License

This project is licensed under the [MIT License](LICENSE).
