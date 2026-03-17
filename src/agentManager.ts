import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  JSONL_POLL_INTERVAL_MS,
  TERMINAL_NAME_PREFIX,
  WORKSPACE_KEY_AGENT_SEATS,
  WORKSPACE_KEY_AGENTS,
} from './constants.js';
import { ensureProjectScan, readNewLines, startFileWatching } from './fileWatcher.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import type { AgentState, PersistedAgent } from './types.js';

export function getProjectDirPath(cwd?: string): string | null {
  const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) return null;
  const dirName = workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
  const projectDir = path.join(os.homedir(), '.claude', 'projects', dirName);
  console.log(`[Pixel Sloths] Project dir: ${workspacePath} → ${dirName}`);
  return projectDir;
}

/** Returns all project directories under ~/.claude/projects/ that contain JSONL files */
export function getAllProjectDirs(): string[] {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  try {
    return fs
      .readdirSync(projectsRoot)
      .map((d) => path.join(projectsRoot, d))
      .filter((d) => {
        try {
          if (!fs.statSync(d).isDirectory()) return false;
          // Only include dirs that have JSONL files
          const files = fs.readdirSync(d);
          return files.some((f) => f.endsWith('.jsonl'));
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

export async function launchNewTerminal(
  nextAgentIdRef: { current: number },
  nextTerminalIndexRef: { current: number },
  agents: Map<number, AgentState>,
  activeAgentIdRef: { current: number | null },
  knownJsonlFiles: Set<string>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimers: Map<string, ReturnType<typeof setInterval>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
  folderPath?: string,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  const cwd = folderPath || folders?.[0]?.uri.fsPath;
  const isMultiRoot = !!(folders && folders.length > 1);
  const idx = nextTerminalIndexRef.current++;
  const terminal = vscode.window.createTerminal({
    name: `${TERMINAL_NAME_PREFIX} #${idx}`,
    cwd,
  });
  terminal.show();

  const sessionId = crypto.randomUUID();
  terminal.sendText(`claude --session-id ${sessionId}`);

  const projectDir = getProjectDirPath(cwd);
  if (!projectDir) {
    console.log(`[Pixel Sloths] No project dir, cannot track agent`);
    return;
  }

  // Pre-register expected JSONL file so project scan won't treat it as a /clear file
  const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
  knownJsonlFiles.add(expectedFile);

  // Create agent immediately (before JSONL file exists)
  const id = nextAgentIdRef.current++;
  const folderName = isMultiRoot && cwd ? path.basename(cwd) : undefined;
  const agent: AgentState = {
    id,
    terminalRef: terminal,
    projectDir,
    jsonlFile: expectedFile,
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
    folderName,
  };

  agents.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();
  console.log(`[Pixel Sloths] Agent ${id}: created for terminal ${terminal.name}`);
  webview?.postMessage({ type: 'agentCreated', id, folderName });

  ensureProjectScan(
    projectDir,
    knownJsonlFiles,
    projectScanTimers,
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

  // Poll for the specific JSONL file to appear
  const pollTimer = setInterval(() => {
    try {
      if (fs.existsSync(agent.jsonlFile)) {
        console.log(
          `[Pixel Sloths] Agent ${id}: found JSONL file ${path.basename(agent.jsonlFile)}`,
        );
        clearInterval(pollTimer);
        jsonlPollTimers.delete(id);
        startFileWatching(
          id,
          agent.jsonlFile,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          webview,
        );
        readNewLines(id, agents, waitingTimers, permissionTimers, webview);
      }
    } catch {
      /* file may not exist yet */
    }
  }, JSONL_POLL_INTERVAL_MS);
  jsonlPollTimers.set(id, pollTimer);
}

export function removeAgent(
  agentId: number,
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  persistAgents: () => void,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  // Stop JSONL poll timer
  const jpTimer = jsonlPollTimers.get(agentId);
  if (jpTimer) {
    clearInterval(jpTimer);
  }
  jsonlPollTimers.delete(agentId);

  // Stop file watching
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

  // Cancel timers
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);

  // Remove from maps
  agents.delete(agentId);
  persistAgents();
}

export function persistAgents(
  agents: Map<number, AgentState>,
  context: vscode.ExtensionContext,
): void {
  const persisted: PersistedAgent[] = [];
  for (const agent of agents.values()) {
    persisted.push({
      id: agent.id,
      terminalName: agent.terminalRef?.name ?? 'vscode-extension',
      jsonlFile: agent.jsonlFile,
      projectDir: agent.projectDir,
      folderName: agent.folderName,
    });
  }
  context.workspaceState.update(WORKSPACE_KEY_AGENTS, persisted);
}

export function restoreAgents(
  context: vscode.ExtensionContext,
  nextAgentIdRef: { current: number },
  nextTerminalIndexRef: { current: number },
  agents: Map<number, AgentState>,
  knownJsonlFiles: Set<string>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimers: Map<string, ReturnType<typeof setInterval>>,
  activeAgentIdRef: { current: number | null },
  webview: vscode.Webview | undefined,
  doPersist: () => void,
): void {
  const persisted = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS, []);
  if (persisted.length === 0) return;

  const liveTerminals = vscode.window.terminals;
  let maxId = 0;
  let maxIdx = 0;
  let restoredProjectDir: string | null = null;

  for (const p of persisted) {
    const terminal = liveTerminals.find((t) => t.name === p.terminalName);
    // Allow restoration without terminal for VS Code extension mode
    if (!terminal && p.terminalName !== 'vscode-extension') continue;

    const agent: AgentState = {
      id: p.id,
      terminalRef: terminal ?? null,
      projectDir: p.projectDir,
      jsonlFile: p.jsonlFile,
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
      folderName: p.folderName,
    };

    agents.set(p.id, agent);
    knownJsonlFiles.add(p.jsonlFile);
    console.log(
      `[Pixel Sloths] Restored agent ${p.id} → ${terminal ? `terminal "${p.terminalName}"` : 'VS Code extension mode'}`,
    );

    if (p.id > maxId) maxId = p.id;
    // Extract terminal index from name like "Claude Code #3"
    const match = p.terminalName.match(/#(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (idx > maxIdx) maxIdx = idx;
    }

    restoredProjectDir = p.projectDir;

    // Start file watching if JSONL exists, skipping to end of file
    try {
      if (fs.existsSync(p.jsonlFile)) {
        const stat = fs.statSync(p.jsonlFile);
        agent.fileOffset = stat.size;
        startFileWatching(
          p.id,
          p.jsonlFile,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          webview,
        );
      } else {
        // Poll for the file to appear
        const pollTimer = setInterval(() => {
          try {
            if (fs.existsSync(agent.jsonlFile)) {
              console.log(`[Pixel Sloths] Restored agent ${p.id}: found JSONL file`);
              clearInterval(pollTimer);
              jsonlPollTimers.delete(p.id);
              const stat = fs.statSync(agent.jsonlFile);
              agent.fileOffset = stat.size;
              startFileWatching(
                p.id,
                agent.jsonlFile,
                agents,
                fileWatchers,
                pollingTimers,
                waitingTimers,
                permissionTimers,
                webview,
              );
            }
          } catch {
            /* file may not exist yet */
          }
        }, JSONL_POLL_INTERVAL_MS);
        jsonlPollTimers.set(p.id, pollTimer);
      }
    } catch {
      /* ignore errors during restore */
    }
  }

  // Advance counters past restored IDs
  if (maxId >= nextAgentIdRef.current) {
    nextAgentIdRef.current = maxId + 1;
  }
  if (maxIdx >= nextTerminalIndexRef.current) {
    nextTerminalIndexRef.current = maxIdx + 1;
  }

  // Re-persist cleaned-up list (removes entries whose terminals are gone)
  doPersist();

  // Start project scan for /clear detection
  if (restoredProjectDir) {
    ensureProjectScan(
      restoredProjectDir,
      knownJsonlFiles,
      projectScanTimers,
      activeAgentIdRef,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      webview,
      doPersist,
    );
  }
}

export function sendExistingAgents(
  agents: Map<number, AgentState>,
  context: vscode.ExtensionContext,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  const agentIds: number[] = [];
  for (const id of agents.keys()) {
    agentIds.push(id);
  }
  agentIds.sort((a, b) => a - b);

  // Include persisted palette/seatId from separate key
  const agentMeta = context.workspaceState.get<
    Record<string, { palette?: number; seatId?: string }>
  >(WORKSPACE_KEY_AGENT_SEATS, {});

  // Include folderName per agent
  const folderNames: Record<number, string> = {};
  for (const [id, agent] of agents) {
    if (agent.folderName) {
      folderNames[id] = agent.folderName;
    }
  }
  console.log(
    `[Pixel Sloths] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`,
  );

  webview.postMessage({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta,
    folderNames,
  });

  sendCurrentAgentStatuses(agents, webview);
}

export interface DiscoveredSession {
  jsonlFile: string;
  projectDir: string;
  projectName: string;
  lastModified: number;
  sizeKB: number;
}

/** Scans all project dirs for active JSONL files not already tracked by an agent */
export function getActiveSessions(agents: Map<number, AgentState>): DiscoveredSession[] {
  const trackedFiles = new Set<string>();
  for (const agent of agents.values()) {
    trackedFiles.add(agent.jsonlFile);
  }

  const RECENT_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
  const now = Date.now();
  const sessions: DiscoveredSession[] = [];

  for (const dir of getAllProjectDirs()) {
    const dirName = path.basename(dir);
    // Convert project dir name back to readable form
    const projectName = dirName.replace(/^-/, '').replace(/-/g, '/');
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dir, f));
      for (const f of files) {
        if (trackedFiles.has(f)) continue;
        try {
          const stat = fs.statSync(f);
          const age = now - stat.mtimeMs;
          if (age < RECENT_THRESHOLD_MS && stat.size > 0) {
            sessions.push({
              jsonlFile: f,
              projectDir: dir,
              projectName,
              lastModified: stat.mtimeMs,
              sizeKB: Math.round(stat.size / 1024),
            });
          }
        } catch {
          /* stat failed */
        }
      }
    } catch {
      /* dir read failed */
    }
  }

  // Sort by most recently modified first
  sessions.sort((a, b) => b.lastModified - a.lastModified);
  return sessions;
}

/** Adopt a specific JSONL session file as a new agent */
export function adoptSessionByFile(
  jsonlFile: string,
  projectDir: string,
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  activeAgentIdRef: { current: number | null },
  knownJsonlFiles: Set<string>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
): void {
  // Check not already tracked
  for (const agent of agents.values()) {
    if (agent.jsonlFile === jsonlFile) return;
  }

  knownJsonlFiles.add(jsonlFile);

  const id = nextAgentIdRef.current++;
  const dirName = path.basename(projectDir).replace(/^-/, '');
  // Extract a short folder name from the project dir
  const parts = dirName.split('-');
  const folderName = parts[parts.length - 1] || dirName;

  const agent: AgentState = {
    id,
    terminalRef: null,
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
    folderName,
  };

  agents.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();

  console.log(`[Pixel Sloths] Agent ${id}: manually adopted session ${path.basename(jsonlFile)}`);
  webview?.postMessage({ type: 'agentCreated', id, folderName });

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

export function sendCurrentAgentStatuses(
  agents: Map<number, AgentState>,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  for (const [agentId, agent] of agents) {
    // Re-send active tools
    for (const [toolId, status] of agent.activeToolStatuses) {
      webview.postMessage({
        type: 'agentToolStart',
        id: agentId,
        toolId,
        status,
      });
    }
    // Re-send waiting status
    if (agent.isWaiting) {
      webview.postMessage({
        type: 'agentStatus',
        id: agentId,
        status: 'waiting',
      });
    }
  }
}

export function sendLayout(
  context: vscode.ExtensionContext,
  webview: vscode.Webview | undefined,
  defaultLayout?: Record<string, unknown> | null,
): void {
  if (!webview) return;
  const result = migrateAndLoadLayout(context, defaultLayout);
  webview.postMessage({
    type: 'layoutLoaded',
    layout: result?.layout ?? null,
    wasReset: result?.wasReset ?? false,
  });
}
