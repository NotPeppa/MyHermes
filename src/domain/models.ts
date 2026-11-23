export type HermesMode = 'native_runs' | 'native_sessions' | 'openai_compat' | 'unsupported';
export type RunState = 'submitting' | 'submission_uncertain' | 'queued' | 'running' | 'waiting_for_approval' | 'waiting_for_clarification' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
export type NetworkState = 'connected' | 'reconnecting' | 'offline';
export interface Capabilities {
  mode: HermesMode;
  features: Record<string, boolean>;
  endpoints?: Record<string, unknown>;
  checkedAt: number;
  model?: string;
}
export interface ServerConnection {
  id: string;
  name: string;
  baseUrl: string;
  credentialRef: string;
  capabilities: Capabilities;
  createdAt: number;
  allowHttp?: boolean;
}
export interface Session {
  serverId: string;
  id: string;
  title: string;
  updatedAt: number;
  localOnly?: boolean;
  /** 分支来源会话（P1 Fork） */
  forkedFrom?: string;
}
/** P2 只读发现：GET /v1/skills、GET /v1/toolsets。 */
export interface Skill {
  name: string;
  description?: string;
  category?: string;
}
export interface Toolset {
  name: string;
  label?: string;
  description?: string;
  enabled?: boolean;
  configured?: boolean;
  tools?: string[];
}
/**
 * P2 定时/后台任务：/api/jobs。官方文档只给出端点与「prompt / schedule / skills /
 * provider override / delivery target」这几个概念，未固定字段名，因此只映射已知字段，
 * 其余一律忽略，不猜测结构。
 */
export interface Job {
  id: string;
  prompt?: string;
  schedule?: string;
  paused?: boolean;
  lastStatus?: string;
  lastRunAt?: number;
}

/** P1 模型选择：来自 GET /api/model/options 的扁平化条目。 */
export interface ModelOption {
  id: string;
  provider?: string;
  /** provider 行的展示名（官方 payload 里叫 label/name） */
  providerLabel?: string;
  label?: string;
  contextWindow?: number;
  /** 服务器当前配置的模型（/api/model/options 的 model+provider） */
  current?: boolean;
}
/** 请求级模型覆盖，缺省则用服务器默认模型。 */
export interface SendOptions {
  model?: string;
  provider?: string;
  /** P1 图片附件：只发压缩后的副本（已重编码，不带 EXIF/定位） */
  images?: ImageAttachment[];
}
/** 已在客户端处理过的图片：重编码为 JPEG、限制长边与体积后再上传。 */
export interface ImageAttachment {
  id: string;
  /** data:image/jpeg;base64,... */
  dataUri: string;
  mimeType: string;
  width: number;
  height: number;
  /** base64 解码后的字节数 */
  bytes: number;
}
export interface Message {
  id: string;
  serverId: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  body: string;
  createdAt: number;
  serverMessageId?: string;
}
export interface OutboundTurn {
  clientTurnId: string;
  serverId: string;
  sessionId: string;
  idempotencyKey: string;
  requestBodyJson: string;
  runId?: string;
  submissionState: RunState;
  createdAt: number;
}
export interface PendingControl {
  request_id: string;
  execution_generation: number;
  type: string;
  prompt: string;
  choices?: string[];
}
export interface Run {
  runId: string;
  serverId: string;
  sessionId: string;
  clientTurnId: string;
  idempotencyKey: string;
  requestBodyJson: string;
  status: RunState;
  rawStatus?: string;
  finalOutput?: string;
  updatedAt: number;
  pendingControls?: PendingControl[];
  admissionId?: string;
  executionGeneration?: number;
}
export interface ToolEvent {
  id: string;
  serverId: string;
  runId: string;
  toolName: string;
  eventType: string;
  preview?: string;
  recordedAt: number;
}
export interface AgentEvent {
  kind: 'text_delta' | 'commentary' | 'tool_started' | 'tool_finished' | 'terminal' | 'control' | 'unknown';
  runId: string;
  rawEventType: string;
  timestamp: number;
  id?: string;
  text?: string;
  tool?: string;
  toolCallId?: string;
  failed?: boolean;
  alreadyStreamed?: boolean;
  state?: RunState;
  output?: string;
  /** 审批/澄清事件自带的待处理项；部分版本不在 status 里给 pending_controls */
  control?: PendingControl;
}
export const terminalStates: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
export const statusLabels: Record<RunState, string> = {
  submitting: '正在提交…', submission_uncertain: '可能已提交，请核对', queued: '已排队', running: 'Hermes 正在执行…',
  waiting_for_approval: '等待操作审批', waiting_for_clarification: '等待补充信息', stopping: '正在停止…',
  completed: '已完成', failed: '执行失败', cancelled: '已取消', interrupted: '服务重启，任务中断', unknown: '执行结果不确定，需要人工核对',
};
