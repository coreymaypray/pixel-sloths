import { useEffect, useRef, useState } from 'react';

import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js';
import { vscode } from '../vscodeApi.js';
import { SettingsModal } from './SettingsModal.js';

interface ActiveSession {
  jsonlFile: string;
  projectDir: string;
  projectName: string;
  lastModified: number;
  sizeKB: number;
}

interface TrackedAgent {
  id: number;
  status: string; // 'active' | 'waiting' | 'idle'
}

interface BottomToolbarProps {
  isEditMode: boolean;
  onOpenClaude: () => void;
  onToggleEditMode: () => void;
  isDebugMode: boolean;
  onToggleDebugMode: () => void;
  workspaceFolders: WorkspaceFolder[];
  trackedAgents: TrackedAgent[];
  onFocusAgent: (id: number) => void;
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 10,
  left: 10,
  zIndex: 'var(--pixel-controls-z)',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  padding: '4px 6px',
  boxShadow: 'var(--pixel-shadow)',
};

const btnBase: React.CSSProperties = {
  padding: '5px 10px',
  fontSize: '24px',
  color: 'var(--pixel-text)',
  background: 'var(--pixel-btn-bg)',
  border: '2px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
};

const btnActive: React.CSSProperties = {
  ...btnBase,
  background: 'var(--pixel-active-bg)',
  border: '2px solid var(--pixel-accent)',
};

export function BottomToolbar({
  isEditMode,
  onOpenClaude,
  onToggleEditMode,
  isDebugMode,
  onToggleDebugMode,
  workspaceFolders,
  trackedAgents,
  onFocusAgent,
}: BottomToolbarProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isMenuOpen]);

  // Listen for active sessions list from extension
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'activeSessionsList') {
        setActiveSessions(e.data.sessions as ActiveSession[]);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const hasMultipleFolders = workspaceFolders.length > 1;

  const handleAgentClick = () => {
    // Request fresh session list each time menu opens
    vscode.postMessage({ type: 'listActiveSessions' });
    setIsMenuOpen((v) => !v);
  };

  const handleNewAgent = (folderPath?: string) => {
    setIsMenuOpen(false);
    if (folderPath) {
      vscode.postMessage({ type: 'openClaude', folderPath });
    } else {
      onOpenClaude();
    }
  };

  const handleAdoptSession = (session: ActiveSession) => {
    setIsMenuOpen(false);
    vscode.postMessage({
      type: 'adoptSession',
      jsonlFile: session.jsonlFile,
      projectDir: session.projectDir,
    });
  };

  // Capture current time when menu opens (avoids impure Date.now during render)
  const [menuOpenTime] = useState(() => Date.now());

  const formatAge = (lastModified: number): string => {
    const mins = Math.round((menuOpenTime - lastModified) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    return `${Math.round(mins / 60)}h ago`;
  };

  const shortProjectName = (name: string): string => {
    const parts = name.split('/');
    return parts[parts.length - 1] || name;
  };

  const menuItemStyle = (key: string): React.CSSProperties => ({
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '6px 10px',
    fontSize: '22px',
    color: 'var(--pixel-text)',
    background: hoveredItem === key ? 'var(--pixel-btn-hover-bg)' : 'transparent',
    border: 'none',
    borderRadius: 0,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });

  const dividerStyle: React.CSSProperties = {
    height: 1,
    background: 'var(--pixel-border)',
    margin: '4px 0',
  };

  const labelStyle: React.CSSProperties = {
    padding: '4px 10px 2px',
    fontSize: '18px',
    color: 'var(--pixel-text)',
    opacity: 0.5,
    userSelect: 'none',
  };

  return (
    <div style={panelStyle}>
      <div ref={menuRef} style={{ position: 'relative' }}>
        <button
          onClick={handleAgentClick}
          onMouseEnter={() => setHovered('agent')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...btnBase,
            padding: '5px 12px',
            background:
              hovered === 'agent' || isMenuOpen
                ? 'var(--pixel-agent-hover-bg)'
                : 'var(--pixel-agent-bg)',
            border: '2px solid var(--pixel-agent-border)',
            color: 'var(--pixel-agent-text)',
          }}
        >
          + Agent
        </button>
        {isMenuOpen && (
          <div
            style={{
              position: 'fixed',
              bottom: 60,
              left: 10,
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              borderRadius: 0,
              boxShadow: '0 -4px 12px rgba(0,0,0,0.5)',
              minWidth: 220,
              maxHeight: 300,
              overflowY: 'auto',
              zIndex: 9999,
            }}
          >
            {/* New Agent section */}
            <div style={labelStyle}>New</div>
            {hasMultipleFolders ? (
              workspaceFolders.map((folder) => (
                <button
                  key={`new-${folder.path}`}
                  onClick={() => handleNewAgent(folder.path)}
                  onMouseEnter={() => setHoveredItem(`new-${folder.path}`)}
                  onMouseLeave={() => setHoveredItem(null)}
                  style={menuItemStyle(`new-${folder.path}`)}
                >
                  + {folder.name}
                </button>
              ))
            ) : (
              <button
                onClick={() => handleNewAgent()}
                onMouseEnter={() => setHoveredItem('new')}
                onMouseLeave={() => setHoveredItem(null)}
                style={menuItemStyle('new')}
              >
                + New Session
              </button>
            )}

            {/* Current tracked agents */}
            {trackedAgents.length > 0 && (
              <>
                <div style={dividerStyle} />
                <div style={labelStyle}>Current</div>
                {trackedAgents.map((agent) => (
                  <button
                    key={`tracked-${agent.id}`}
                    onClick={() => {
                      setIsMenuOpen(false);
                      onFocusAgent(agent.id);
                    }}
                    onMouseEnter={() => setHoveredItem(`tracked-${agent.id}`)}
                    onMouseLeave={() => setHoveredItem(null)}
                    style={menuItemStyle(`tracked-${agent.id}`)}
                  >
                    <span>Agent {agent.id}</span>
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: '16px',
                        opacity: 0.5,
                        color:
                          agent.status === 'active'
                            ? 'var(--pixel-accent, #0f0)'
                            : agent.status === 'waiting'
                              ? '#f90'
                              : 'inherit',
                      }}
                    >
                      {agent.status === 'active' ? 'working' : agent.status}
                    </span>
                  </button>
                ))}
              </>
            )}

            {/* Untracked active sessions */}
            {activeSessions.length > 0 && (
              <>
                <div style={dividerStyle} />
                <div style={labelStyle}>Adopt Session</div>
                {activeSessions.map((session, i) => (
                  <button
                    key={session.jsonlFile}
                    onClick={() => handleAdoptSession(session)}
                    onMouseEnter={() => setHoveredItem(`session-${i}`)}
                    onMouseLeave={() => setHoveredItem(null)}
                    style={menuItemStyle(`session-${i}`)}
                  >
                    <span>{shortProjectName(session.projectName)}</span>
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: '16px',
                        opacity: 0.5,
                      }}
                    >
                      {formatAge(session.lastModified)}
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
      <button
        onClick={onToggleEditMode}
        onMouseEnter={() => setHovered('edit')}
        onMouseLeave={() => setHovered(null)}
        style={
          isEditMode
            ? { ...btnActive }
            : {
                ...btnBase,
                background: hovered === 'edit' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
              }
        }
        title="Edit office layout"
      >
        Layout
      </button>
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setIsSettingsOpen((v) => !v)}
          onMouseEnter={() => setHovered('settings')}
          onMouseLeave={() => setHovered(null)}
          style={
            isSettingsOpen
              ? { ...btnActive }
              : {
                  ...btnBase,
                  background:
                    hovered === 'settings' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
                }
          }
          title="Settings"
        >
          Settings
        </button>
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          isDebugMode={isDebugMode}
          onToggleDebugMode={onToggleDebugMode}
        />
      </div>
    </div>
  );
}
