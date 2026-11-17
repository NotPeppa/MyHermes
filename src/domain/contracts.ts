import type { Capabilities, ServerConnection, Session, Message, OutboundTurn, Run, ToolEvent } from './models';

export interface Repository {
  init(): Promise<void>;
  listServers(): Promise<ServerConnection[]>;
  saveServer(server: ServerConnection): Promise<void>;
  deleteServer(serverId: string): Promise<void>;
  listSessions(serverId: string): Promise<Session[]>;
  saveSessions(serverId: string, sessions: Session[]): Promise<void>;
  deleteSession(serverId: string, sessionId: string): Promise<void>;
  listMessages(serverId: string, sessionId: string): Promise<Message[]>;
  replaceMessages(serverId: string, sessionId: string, messages: Message[]): Promise<void>;
  saveTurn(turn: OutboundTurn): Promise<void>;
  listTurns(serverId: string, sessionId?: string): Promise<OutboundTurn[]>;
  saveRun(run: Run): Promise<void>;
  listRuns(serverId: string, sessionId?: string): Promise<Run[]>;
  saveToolEvent(event: ToolEvent): Promise<void>;
  listToolEvents(serverId: string, runId: string): Promise<ToolEvent[]>;
  clearCache(serverId: string): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  listPendingCredentialDeletes(): Promise<string[]>;
  finishCredentialDelete(ref: string): Promise<void>;
}
export interface CredentialVault {
  get(ref: string): Promise<string | null>;
  set(ref: string, key: string): Promise<void>;
  remove(ref: string): Promise<void>;
}
export interface ProbeResult { capabilities: Capabilities; latencyMs: number }
