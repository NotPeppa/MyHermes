import { Redirect, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { useAppServices } from '@/composition';
import { LoadingView, Screen } from '@/ui/primitives';

/** 有实例进会话列表，没有则进连接页。 */
export default function Index() {
  const { repository } = useAppServices();
  const [target, setTarget] = useState<Href | null>(null);

  useEffect(() => {
    let alive = true;
    repository
      .listServers()
      .then((servers) => {
        if (alive) setTarget(servers.length > 0 ? '/(main)/sessions' : '/(onboarding)/add-server');
      })
      .catch(() => {
        if (alive) setTarget('/(onboarding)/add-server');
      });
    return () => {
      alive = false;
    };
  }, [repository]);

  if (!target) {
    return (
      <Screen>
        <LoadingView label="正在读取实例…" />
      </Screen>
    );
  }
  return <Redirect href={target} />;
}
