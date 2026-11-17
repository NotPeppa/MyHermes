/**
 * 相册选择 + 重编码。原生调用集中在此，便于替换或替换失败时降级。
 * 重编码（manipulateAsync）会丢弃 EXIF/定位等元数据，只保留像素。
 */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import type { ImageAttachment } from '@/domain/models';
import { attachmentFrom, checkAttachment, isAcceptedMime, MAX_EDGE, targetSize, type SourceImage } from './image';

export type PickResult =
  | { kind: 'cancelled' }
  | { kind: 'denied'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'picked'; attachment: ImageAttachment };

let counter = 0;
const nextId = () => `img_${Date.now().toString(36)}_${(counter += 1)}`;

/** 选择一张图片并处理成可上传的附件；用户取消返回 cancelled，不抛错。 */
export async function pickImage(existingCount = 0): Promise<PickResult> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return { kind: 'denied', message: '需要相册权限才能选择图片；可在系统设置里开启。' };
  }
  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: false,
    exif: false,
    quality: 1,
  });
  if (picked.canceled || !picked.assets?.[0]) return { kind: 'cancelled' };
  const asset = picked.assets[0];
  if (!isAcceptedMime(asset.mimeType)) {
    return { kind: 'error', message: '只支持 JPEG / PNG / WebP / HEIC 图片' };
  }
  return processImage(
    {
      uri: asset.uri,
      width: asset.width,
      height: asset.height,
      mimeType: asset.mimeType,
      fileSize: asset.fileSize,
    },
    existingCount,
  );
}

/** 缩放 + JPEG 重编码 + base64，返回附件或可读错误。 */
export async function processImage(source: SourceImage, existingCount = 0): Promise<PickResult> {
  try {
    const size = targetSize(source.width ?? MAX_EDGE, source.height ?? MAX_EDGE);
    const context = ImageManipulator.manipulate(source.uri);
    context.resize({ width: size.width, height: size.height });
    const rendered = await context.renderAsync();
    const saved = await rendered.saveAsync({ compress: 0.7, format: SaveFormat.JPEG, base64: true });
    if (!saved.base64) return { kind: 'error', message: '图片处理失败，请换一张重试' };
    const attachment = attachmentFrom(saved.base64, {
      id: nextId(),
      width: saved.width ?? size.width,
      height: saved.height ?? size.height,
      mimeType: 'image/jpeg',
    });
    const rejected = checkAttachment(attachment, existingCount);
    if (rejected) return { kind: 'error', message: rejected };
    return { kind: 'picked', attachment };
  } catch {
    return { kind: 'error', message: '图片处理失败，请换一张重试' };
  }
}
