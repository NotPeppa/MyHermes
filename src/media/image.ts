/**
 * 图片附件处理（设计 §15）：只上传压缩后的副本，不传相册原图。
 * 纯逻辑放在这里以便单测；原生调用集中在 src/media/picker.ts。
 */
import type { ImageAttachment } from '@/domain/models';

export const MAX_EDGE = 1568;
export const MAX_BYTES = 3 * 1024 * 1024;
export const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;
export const MAX_IMAGES = 4;

export interface SourceImage {
  uri: string;
  width?: number;
  height?: number;
  mimeType?: string;
  fileSize?: number;
}

/** 长边限制到 MAX_EDGE，返回等比缩放后的尺寸；小图不放大。 */
export function targetSize(width: number, height: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: maxEdge, height: maxEdge };
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxEdge / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function isAcceptedMime(mimeType: string | undefined): boolean {
  if (!mimeType) return true; // 相册返回缺失类型时交给重编码兜底
  return (ACCEPTED_MIME as readonly string[]).includes(mimeType.toLowerCase());
}

export function dataUriOf(base64: string, mimeType = 'image/jpeg'): string {
  return `data:${mimeType};base64,${base64}`;
}

/** base64 字节数（不含填充带来的误差，够用于体积上限判断）。 */
export function base64Bytes(base64: string): number {
  const clean = base64.replace(/=+$/, '');
  return Math.floor((clean.length * 3) / 4);
}

export function attachmentFrom(
  base64: string,
  meta: { id: string; width: number; height: number; mimeType?: string },
): ImageAttachment {
  const mimeType = meta.mimeType ?? 'image/jpeg';
  return {
    id: meta.id,
    dataUri: dataUriOf(base64, mimeType),
    mimeType,
    width: meta.width,
    height: meta.height,
    bytes: base64Bytes(base64),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 校验并给出可读拒绝原因；通过则返回 null。 */
export function checkAttachment(attachment: ImageAttachment, existing: number): string | null {
  if (existing >= MAX_IMAGES) return `最多附加 ${MAX_IMAGES} 张图片`;
  if (attachment.bytes > MAX_BYTES) return `单张图片需小于 ${formatBytes(MAX_BYTES)}，当前 ${formatBytes(attachment.bytes)}`;
  if (!attachment.mimeType.startsWith('image/')) return '只支持图片文件';
  return null;
}

export type ImageContentPart = { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };
export type TextContentPart = { type: 'text'; text: string };

/**
 * OpenAI Chat Completions 的 content 数组（官方文档确认 image_url + data:image）。
 * 纯文本时保持字符串形式，避免改变既有请求体。
 */
export function buildCompatContent(text: string, images: ImageAttachment[] | undefined): string | { type: string }[] {
  if (!images || images.length === 0) return text;
  const parts: (TextContentPart | ImageContentPart)[] = [];
  if (text.trim().length > 0) parts.push({ type: 'text', text });
  for (const image of images) {
    parts.push({ type: 'image_url', image_url: { url: image.dataUri, detail: 'high' } });
  }
  return parts;
}

/** 历史消息里图片以 [image] 占位符出现时，正文按原文保留。 */
export const IMAGE_PLACEHOLDER = '[image]';
