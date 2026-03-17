import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { FILE_WATCHER_POLL_INTERVAL_MS, PROJECT_SCAN_INTERVAL_MS } from './constants.js';
import { cancelPermissionTimer, cancelWaitingTimer, clearAgentActivity } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import type { AgentState } from './types.js';

export function startFileWatching(
  agentId: number,
  filePath: string,
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  // Primary: fs.watch (unreliable on macOS — may miss events)
  try {
    const watcher = fs.watch(filePath, () => {
      readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
    });
    fileWatchers.set(agentId, watcher);
  } catch (e) {
    console.log(`[Pixel Sloths] fs.watch failed for agent ${agentId}: ${e}`);
  }

  // Secondary: fs.watchFile (stat-based polling, reliable on macOS)
  try {
    fs.watchFile(filePath, { interval: FILE_WATCHER_POLL_INTERVAL_MS }, () => {
      readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
    });
  } catch (e) {
    console.log(`[Pixel Sloths] fs.watchFile failed for agent ${agentId}: ${e}`);
  }

  // Tertiary: manual poll as last resort
  const interval = setInterval(() => {
    if (!agents.has(agentId)) {
      clearInterval(interval);
      try {
        fs.unwatchFile(filePath);
      } catch {
        /* ignore */
      }
      return;
    }
    readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
  }, FILE_WATCHER_POLL_INTERVAL_MS);
  pollingTimers.set(agentId, interval);
}

export function readNewLines(
  agentId: number,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  try {
    const stat = fs.statSync(agent.jsonlFile);
    if (stat.size <= agent.fileOffset) return;

    const buf = Buffer.alloc(stat.size - agent.fileOffset);
    const fd = fs.openSync(agent.jsonlFile, 'r');
    fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
    fs.closeSync(fd);
    agent.fileOffset = stat.size;

    const text = agent.lineBuffer + buf.toString('utf-8');
    const lines = text.split('\n');
    agent.lineBuffer = lines.pop() || '';

    const hasLines = lines.some((l) => l.trim());
    if (hasLines) {
      // New data arriving — cancel timers (data flowing means agent is still active)
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);
      if (agent.permissionSent) {
        agent.permissionSent = false;
        webview?.postMessage({ type: 'agentToolPermissionClear', id: agentId });
      }
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers, webview);
    }
  } catch (e) {
    console.log(`[Pixel Sloths] Read error for agent ${agentId}: ${e}`);
  }
}

export function ensureProjectScan(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  projectScanTimers: Map<string, ReturnType<typeof setInterval>>,
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
): void {
  if (projectScanTimers.has(projectDir)) return;

  // Auto-adopt recently active JSONL files (modified within last 5 minutes)
  // This picks up sessions from the VS Code Claude Code extension
  const RECENT_THRESHOLD_MS = 5 * 60 * 1000;
  const now = Date.now();
  try {
    const files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
    for (const f of files) {
      knownJsonlFiles.add(f);
      // Check if this file is recently active and not already tracked
      try {
        const stat = fs.statSync(f);
        const age = now - stat.mtimeMs;
        if (age < RECENT_THRESHOLD_MS && stat.size > 0) {
          // Check if any agent already tracks this file
          let alreadyTracked = false;
          for (const agent of agents.values()) {
            if (agent.jsonlFile === f) {
              alreadyTracked = true;
              break;
            }
          }
          if (!alreadyTracked) {
            console.log(
              `[Pixel Sloths] Auto-adopting active session: ${path.basename(f)} (${Math.round(age / 1000)}s old)`,
            );
            autoAdoptJsonlFile(
              f,
              projectDir,
              nextAgentIdRef,
              agents,
              activeAgentIdRef,
              fileWatchers,
              pollingTimers,
              waitingTimers,
              permissionTimers,
              webview,
              persistAgents,
            );
          }
        }
      } catch {
        /* stat failed, skip */
      }
    }
  } catch {
    /* dir may not exist yet */
  }

  const timer = setInterval(() => {
    scanForNewJsonlFiles(
      projectDir,
      knownJsonlFiles,
      activeAgentIdRef,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      webview,
      persistAgents,
    );
  }, PROJECT_SCAN_INTERVAL_MS);
  projectScanTimers.set(projectDir, timer);
}

function scanForNewJsonlFiles(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
): void {
  let files: string[];
  try {
    files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
  } catch {
    return;
  }

  for (const file of files) {
    if (!knownJsonlFiles.has(file)) {
      knownJsonlFiles.add(file);
      if (activeAgentIdRef.current !== null) {
        // Active agent focused → /clear reassignment
        console.log(
          `[Pixel Sloths] New JSONL detected: ${path.basename(file)}, reassigning to agent ${activeAgentIdRef.current}`,
        );
        reassignAgentToFile(
          activeAgentIdRef.current,
          file,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          webview,
          persistAgents,
        );
      } else {
        // No active agent → try to adopt the focused terminal
        const activeTerminal = vscode.window.activeTerminal;
        if (activeTerminal) {
          let owned = false;
          for (const agent of agents.values()) {
            if (agent.terminalRef === activeTerminal) {
              owned = true;
              break;
            }
          }
          if (!owned) {
            adoptTerminalForFile(
              activeTerminal,
              file,
              projectDir,
              nextAgentIdRef,
              agents,
              activeAgentIdRef,
              fileWatchers,
              pollingTimers,
              waitingTimers,
              permissionTimers,
              webview,
              persistAgents,
            );
          }
        }
      }
    }
  }
}

function autoAdoptJsonlFile(
  jsonlFile: string,
  projectDir: string,
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  activeAgentIdRef: { current: number | null },
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
): void {
  // Find an existing terminal to associate with (prefer Claude Code terminals)
  // Allow null for VS Code extension mode (no CLI terminals)
  const terminals = vscode.window.terminals;
  const terminal = terminals.find((t) => t.name.includes('Claude')) || terminals[0] || null;

  const id = nextAgentIdRef.current++;
  const agent: AgentState = {
    id,
    terminalRef: terminal,
    projectDir,
    jsonlFile,
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
  };

  agents.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();

  console.log(
    `[Pixel Sloths] Agent ${id}: auto-adopted session ${path.basename(jsonlFile)}${terminal ? ` on "${terminal.name}"` : ' (VS Code extension mode)'}`,
  );
  webview?.postMessage({ type: 'agentCreated', id });

  startFileWatching(
    id,
    jsonlFile,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
    webview,
  );
  readNewLines(id, agents, waitingTimers, permissionTimers, webview);
}

function adoptTerminalForFile(
  terminal: vscode.Terminal,
  jsonlFile: string,
  projectDir: string,
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  activeAgentIdRef: { current: number | null },
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
): void {
  const id = nextAgentIdRef.current++;
  const agent: AgentState = {
    id,
    terminalRef: terminal,
    projectDir,
    jsonlFile,
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
  };

  agents.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();

  console.log(
    `[Pixel Sloths] Agent ${id}: adopted terminal "${terminal.name}" for ${path.basename(jsonlFile)}`,
  );
  webview?.postMessage({ type: 'agentCreated', id });

  startFileWatching(
    id,
    jsonlFile,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
    webview,
  );
  readNewLines(id, agents, waitingTimers, permissionTimers, webview);
}

export function reassignAgentToFile(
  agentId: number,
  newFilePath: string,
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  // Stop old file watching
  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) {
    clearInterval(pt);
  }
  pollingTimers.delete(agentId);
  try {
    fs.unwatchFile(agent.jsonlFile);
  } catch {
    /* ignore */
  }

  // Clear activity
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);
  clearAgentActivity(agent, agentId, permissionTimers, webview);

  // Swap to new file
  agent.jsonlFile = newFilePath;
  agent.fileOffset = 0;
  agent.lineBuffer = '';
  persistAgents();

  // Start watching new file
  startFileWatching(
    agentId,
    newFilePath,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
    webview,
  );
  readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);
}
