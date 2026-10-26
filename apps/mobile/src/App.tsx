import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { createTranslator } from '@idcp/shared';
import { ApiClient } from './api/client';
import { KeychainStore } from './auth/secureStore';
import { createPersistentQueue } from './state/queueStorage';
import { CaptureScreen } from './screens/CaptureScreen';
import { createFrameBridge } from './capture/useDocumentDetector';
import { QueueScreen } from './screens/QueueScreen';
import { ReviewScreen } from './screens/ReviewScreen';
import { SignInScreen } from './screens/SignInScreen';
import { PairingScreen } from './screens/PairingScreen';
import { colors, spacing, typography } from './ui/theme';
import type { UploadQueue } from './state/uploadQueue';

const t = createTranslator('en');

/** Configured at build time (`IDCP_API_URL`), or learned from the pairing QR code. */
const DEFAULT_ENDPOINT = process.env.IDCP_API_URL ?? 'https://app.idcp.example';

type Tab = 'capture' | 'queue' | 'review';

type SessionState = 'checking' | 'signed_out' | 'signed_in';

export function App(): React.JSX.Element {
  const store = useMemo(() => new KeychainStore(), []);
  const [endpoint, setEndpoint] = useState<string>(DEFAULT_ENDPOINT);
  const [session, setSession] = useState<SessionState>('checking');
  const [paired, setPaired] = useState<boolean>(false);
  const [tab, setTab] = useState<Tab>('capture');

  const client = useMemo(
    () =>
      new ApiClient({
        baseUrl: endpoint,
        store,
        onSessionExpired: () => setSession('signed_out'),
      }),
    [endpoint, store],
  );

  const queue: UploadQueue = useMemo(() => createPersistentQueue(store, client), [store, client]);
  // MOB-002: one bridge for the session; the capture screen subscribes to it.
  const frameBridge = useMemo(() => createFrameBridge(), []);

  // Restore the session on launch: a refresh token means the person stays signed in.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [refreshToken, deviceCredential] = await Promise.all([
        store.getRefreshToken(),
        store.getDeviceCredential(),
      ]);
      if (cancelled) return;
      setPaired(Boolean(deviceCredential));
      setSession(refreshToken ? 'signed_in' : 'signed_out');
      await queue.load();
    })();
    return () => {
      cancelled = true;
    };
  }, [queue, store]);

  if (session === 'checking') {
    return (
      <SafeAreaView style={styles.centered}>
        <Text style={styles.title}>{t('app.name')}</Text>
        <Text style={styles.muted}>{t('app.tagline')}</Text>
      </SafeAreaView>
    );
  }

  if (!paired) {
    return (
      <SafeAreaView style={styles.root}>
        <PairingScreen
          client={client}
          store={store}
          onPaired={() => {
            setPaired(true);
            setEndpoint(client.getEndpoint());
          }}
        />
        <View style={styles.footer}>
          <Text style={styles.muted}>{t('pairing.instructions')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (session === 'signed_out') {
    return (
      <SafeAreaView style={styles.root}>
        <SignInScreen
          onSignIn={async (email, password) => {
            await client.login({ email, password });
            setSession('signed_in');
          }}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.body}>
        {tab === 'capture' && <CaptureScreen queue={queue} bridge={frameBridge} />}
        {tab === 'queue' && <QueueScreen queue={queue} onOpenReview={() => setTab('review')} />}
        {tab === 'review' && <ReviewScreen client={client} />}
      </View>
      <View style={styles.tabs}>
        {(
          [
            ['capture', t('capture.title')],
            ['queue', t('queue.title')],
            ['review', t('review.title')],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <Text
            key={key}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === key }}
            onPress={() => setTab(key)}
            style={[styles.tab, tab === key && styles.tabActive]}
          >
            {label}
          </Text>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    gap: spacing.sm,
  },
  title: { ...typography.title },
  muted: { ...typography.muted, textAlign: 'center' },
  footer: { padding: spacing.md },
  tabs: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  tab: {
    flex: 1,
    textAlign: 'center',
    paddingVertical: spacing.md,
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  tabActive: { color: colors.primary },
});
