const pad = (value: number) => String(value).padStart(2, '0');

/**
 * 时间是否可信：服务器没给 timestamp 时适配层用序号占位（0、1、2…），
 * 这种值不能当真实时间显示，否则会渲染成 1970-01-01 08:00。
 */
export function hasKnownTime(timestamp: number | undefined | null): boolean {
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 1e11;
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '未知';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatTime(timestamp)}`;
}

/** 列表用的相对时间；超过 7 天回落到日期，避免出现"37 天前"这类噪音。 */
export function formatRelative(timestamp: number, now: number = Date.now()): string {
  const diff = now - timestamp;
  if (!Number.isFinite(diff)) return '';
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDateTime(timestamp);
}
