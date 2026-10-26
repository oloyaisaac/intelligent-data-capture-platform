import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { createTranslator } from '@idcp/shared';
import { colors, spacing, typography } from '../ui/theme';

const t = createTranslator('en');

/**
 * Sign-in for the person holding the phone. Pairing gives the device its credential; this gives
 * the person a session so they can review records on the phone. Reviewer role or above is needed
 * for the review tab — the server decides, and a 403 is shown honestly here.
 */
export function SignInScreen({
  onSignIn,
}: {
  onSignIn: (email: string, password: string) => Promise<void>;
}): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await onSignIn(email.trim(), password);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{t('app.name')}</Text>
      <Text style={styles.tagline}>{t('app.tagline')}</Text>

      <Text style={styles.label}>{t('auth.email')}</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        inputMode="email"
        accessibilityLabel={t('auth.email')}
      />

      <Text style={styles.label}>{t('auth.password')}</Text>
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="password"
        accessibilityLabel={t('auth.password')}
      />

      {error && (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      )}

      <Pressable
        accessibilityRole="button"
        disabled={busy || email.length === 0 || password.length === 0}
        onPress={() => void submit()}
        style={[styles.button, (busy || !email || !password) && styles.disabled]}
      >
        {busy ? (
          <ActivityIndicator color="#04120c" />
        ) : (
          <Text style={styles.buttonText}>{t('action.signIn')}</Text>
        )}
      </Pressable>

      <Text style={styles.hint}>{t('auth.passwordRule')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.sm },
  title: { ...typography.title },
  tagline: { ...typography.muted, marginBottom: spacing.lg },
  label: { ...typography.muted, marginTop: spacing.sm },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  button: {
    marginTop: spacing.lg,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  disabled: { opacity: 0.4 },
  buttonText: { ...typography.subtitle, color: '#04120c' },
  error: { ...typography.body, color: colors.danger, marginTop: spacing.sm },
  hint: { ...typography.muted, marginTop: spacing.md },
});
