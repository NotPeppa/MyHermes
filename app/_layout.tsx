import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { AppServicesProvider, useAppInit } from '@/composition';
import { setPendingIntent } from '@/features/intents/pending';
import { Banner, Button, LoadingView, Screen } from '@/ui/primitives';
import { ThemeProvider, useTheme } from '@/ui/theme';

export default function RootLayout() {
  return (
    <ShareIntentProvider>
      <SafeAreaProvider>
        <ThemeProvider>
          <AppServicesProvider>
            <BootGate />
          </AppServicesProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </ShareIntentProvider>
  );
}

/**
 * 系统分享进来的文本/图片：交给统一的外部入口页处理（选实例、选会话、预填，不自动发送）。
 * 原生模块缺失时（例如 Expo Go）hook 返回空状态，这里什么也不做。
 */
function ShareIntentBridge() {
  const router = useRouter();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();

  useEffect(() => {
    if (!hasShareIntent) return;
    const text = shareIntent.text?.trim();
    const imageUri = shareIntent.files?.find((file) => file.mimeType?.startsWith('image/'))?.path;
    if (!text && !imageUri) {
      resetShareIntent();
      return;
    }
    setPendingIntent({ source: 'share', text: text || undefined, imageUri });
    resetShareIntent();
    router.push({ pathname: '/send', params: { source: 'share' } });
  }, [hasShareIntent, resetShareIntent, router, shareIntent]);

  return null;
}

function BootGate() {
  const theme = useTheme();
  const { ready, error, retry } = useAppInit();
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      {ready ? (
        <>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: theme.colors.bg },
              animation: 'slide_from_right',
            }}
          />
          <ShareIntentBridge />
        </>
      ) : error ? (
        <Screen>
          <View style={{ flex: 1, justifyContent: 'center', padding: theme.space.lg, gap: theme.space.lg }}>
            <Banner tone="error" title="本地数据库初始化失败" action={<Button label="重试" onPress={retry} />}>
              {error}
            </Banner>
          </View>
        </Screen>
      ) : (
        <Screen>
          <LoadingView label="正在初始化本地数据库…" />
        </Screen>
      )}
    </View>
  );
}
