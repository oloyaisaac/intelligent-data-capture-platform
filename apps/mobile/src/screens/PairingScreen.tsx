import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { createTranslator } from '@idcp/shared';
import { QrScannerView } from '../capture/QrScannerView';
import { describeDevice, readPairingCode } from '../pairing/pairing';
import { colors, spacing, typography } from '../ui/theme';
import type { ApiClient, TokenStore } from '../api/client';

const t = createTranslator('en');

/**
 * Pairing (PAIR-002): scan the desktop's code, exchange the single-use token for a device
 * credential, store it in the keychain. Every failure is explainable: wrong app's code,
 * insecure endpoint, expired token, or a network problem.
 */
export function PairingScreen({
  client,
  store,
  onPaired,
}: {
  client: ApiClient;
  store: TokenStore;
  onPaired: (deviceName: string) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [showManual, setShowManual] = useState(false);

  const pair = async (raw: string) => {
    setError(null);
    const parsed = readPairingCode(raw);
    if (!parsed.ok) {
      setError(
        parsed.reason === 'insecure'
          ? 'That code points at an insecure server. Ask for a new code.'
          : parsed.reason === 'not_our_code'
            ? t('pairing.invalidCode')
            : 'That pairing code is incomplete. Ask your computer for a new one.',
      );
      return;
    }

    setBusy(true);
    try {
      client.setEndpoint(parsed.target.endpoint);
      const result = await client.completePairing(
        {
          token: parsed.target.token,
          device: { name: describeDevice('android'), platform: 'android', appVersion: '0.1.0' },
        },
        parsed.target.endpoint,
      );
      await store.saveDeviceCredential(result.deviceCredential);
      onPaired(result.deviceName);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{t('pairing.title')}</Text>
      <Text style={styles.muted}>{t('pairing.instructions')}</Text>

      <View style={styles.scanner}>
        <QrScannerView paused={busy} onScanned={(value) => void pair(value)} />
      </View>

      {busy && (
        <View style={styles.row}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.muted}>Pairing…</Text>
        </View>
      )}

      {error && (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      )}

      <Pressable
        accessibilityRole="button"
        onPress={() => setShowManual((value) => !value)}
        style={styles.link}
      >
        <Text style={styles.linkText}>
          {showManual ? 'Hide manual entry' : 'Enter code manually'}
        </Text>
      </Pressable>

      {showManual && (
        <View style={styles.manual}>
          <Text style={styles.muted}>Paste the link shown under the QR code.</Text>
          <TextInput
            style={styles.input}
            value={manualCode}
            onChangeText={setManualCode}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="idcp://pair?e=…&t=…"
            placeholderTextColor={colors.textMuted}
            accessibilityLabel="Pairing code"
          />
          <Pressable
            accessibilityRole="button"
            disabled={manualCode.length === 0 || busy}
            onPress={() => void pair(manualCode)}
            style={[styles.button, (manualCode.length === 0 || busy) && styles.buttonDisabled]}
          >
            <Text style={styles.buttonText}>{t('action.continue')}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.md },
  title: { ...typography.title, marginBottom: spacing.xs },
  muted: { ...typography.muted, marginBottom: spacing.md },
  scanner: {
    height: 340,
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  error: { ...typography.body, color: colors.danger, marginTop: spacing.md },
  link: { marginTop: spacing.md, paddingVertical: spacing.sm },
  linkText: { ...typography.body, color: colors.primary },
  manual: { gap: spacing.sm },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing.sm,
    color: colors.text,
    backgroundColor: colors.surface,
    fontFamily: 'Courier',
  },
  button: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { ...typography.subtitle, color: '#04120c' },
});
