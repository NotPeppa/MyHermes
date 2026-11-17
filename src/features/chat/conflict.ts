/**
 * 同步冲突模型（设计 §4 P2「同步冲突可视化」、§5.3、§8.4、§14.3）。
 * 只做判定与取值：不碰网络、不碰 UI，因此可以被 node:test 直接导入。
 */
export type ConflictReason = 'server_conflict' | 'submission_uncertain';

export interface Conflict {
  reason: ConflictReason;
  local: { draft: string; lastUserText?: string };
  server: { lastAssistantText?: string; lastUserText?: string; messageCount: number };
  /** 同键重试只对「可能已提交」成立；24 小时与幂等键有效性由服务层在点击时判定。 */
  canRetry: boolean;
  canReload: boolean;
}

/** 只声明用到的视图字段，测试可以直接构造字面量，不必拉起服务层。 */
export interface ConflictView {
  messages: { role: string; body: string; createdAt: number }[];
  draft: string;
  error?: { code: string } | null;
  submission?: { submissionState: string } | null;
}

function lastByRole<T extends { role: string }>(messages: T[], role: string): T | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === role) return message;
  }
  return undefined;
}

export function buildConflict(view: ConflictView): Conflict | null {
  const rejected = view.error?.code === 'conflict';
  const uncertain = view.submission?.submissionState === 'submission_uncertain';
  const lastAssistant = lastByRole(view.messages, 'assistant');
  // 未确认提交只有在服务端已经有 assistant 回复时才说明「可能已执行」，才值得对照
  if (!rejected && !(uncertain && lastAssistant)) return null;
  const lastUser = lastByRole(view.messages, 'user');
  return {
    reason: rejected ? 'server_conflict' : 'submission_uncertain',
    local: { draft: view.draft, ...(lastUser ? { lastUserText: lastUser.body } : {}) },
    server: {
      ...(lastAssistant ? { lastAssistantText: lastAssistant.body } : {}),
      ...(lastUser ? { lastUserText: lastUser.body } : {}),
      messageCount: view.messages.length,
    },
    canRetry: uncertain,
    canReload: true,
  };
}
