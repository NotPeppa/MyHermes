import { Clipboard } from 'react-native';

/**
 * ponytail: RN 内置 Clipboard 已标记废弃但可用，避免为此新增依赖；
 * 若后续加入 expo-clipboard，只改这个文件。
 */
export function copyText(text: string): void {
  Clipboard.setString(text);
}
