import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppServicesProvider, useAppInit } from '@/composition';
import { Banner, Button, LoadingView, Screen } from '@/ui/primitives';
import { ThemeProvider, useTheme } from '@/ui/theme';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AppServicesProvider>
          <BootGate />
        </AppServicesProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function BootGate() {
  const theme = useTheme();
  const { ready, error, retry } = useAppInit();
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      {ready ? (
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: theme.colors.bg },
            animation: 'slide_from_right',
          }}
        />
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
