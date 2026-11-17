/**
 * 外部入口（深链、系统分享、剪贴板快捷方式）与聊天页之间的交接点。
 * 只存内存：外部内容不落盘，聊天页取走后即清空。
 */
export type PendingSource = 'deeplink' | 'share' | 'clipboard';

export interface PendingIntent {
  source: PendingSource;
  text?: string;
  /** 分享进来的图片本地路径（file://），由聊天页按现有流程压缩后再上传 */
  imageUri?: string;
  /** 深链指定的实例；缺省用当前实例 */
  serverId?: string;
}

let pending: PendingIntent | null = null;

export function setPendingIntent(intent: PendingIntent | null): void {
  pending = intent;
}

export function peekPendingIntent(): PendingIntent | null {
  return pending;
}

/** 取走并清空，避免同一条外部内容被重复填入。 */
export function takePendingIntent(): PendingIntent | null {
  const current = pending;
  pending = null;
  return current;
}

export function clearPendingIntent(): void {
  pending = null;
}

export const MAX_INTENT_TEXT = 4000;

/** 外部文本统一裁剪，避免超长深链或分享内容撑爆输入框。 */
export function normalizeIntentText(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const trimmed = text.replace(/\r\n/g, '\n').trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_INTENT_TEXT ? trimmed.slice(0, MAX_INTENT_TEXT) : trimmed;
}
