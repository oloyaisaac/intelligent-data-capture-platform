import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { createTranslator, type ReviewQueueItem, type ReviewSession } from '@idcp/shared';
import { confidenceColor, colors, spacing, typography } from '../ui/theme';
import type { ApiClient } from '../api/client';

const t = createTranslator('en');

/**
 * Review on the phone (REV-001). A reviewer can resolve low-confidence fields, confirm the
 * classification and approve — the same rules the desktop uses, enforced by the server.
 */
export function ReviewScreen({ client }: { client: ApiClient }): React.JSX.Element {
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    setError(null);
    try {
      const response = await client.reviewQueue(25);
      setItems(response.items);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('error.generic'));
    }
  }, [client]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  const open = async (documentId: string) => {
    setBusy(true);
    setError(null);
    try {
      setSession(await client.openReview(documentId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await client.approve(session.reviewId);
      setSession(null);
      await loadQueue();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('review.blockedByFields'));
    } finally {
      setBusy(false);
    }
  };

  if (session) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{t('review.title')}</Text>
        <Text style={styles.muted}>
          {session.documentType} · {session.blocking.length} field(s) to check
        </Text>

        <FlatList
          data={Object.entries(session.udm.fields).filter(([path]) =>
            session.blocking.some((field) => field.path === path),
          )}
          keyExtractor={([path]) => path}
          contentContainerStyle={styles.list}
          renderItem={({ item: [path, field] }) => (
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>{field.label ?? path}</Text>
              <Text style={styles.fieldValue} numberOfLines={2}>
                {field.value === null || field.value === '' ? '—' : String(field.value)}
              </Text>
              <Text style={[styles.muted, { color: confidenceColor(field.confidence) }]}>
                {t('review.confidence', { percent: Math.round(field.confidence * 100) })}
              </Text>
            </View>
          )}
          ListEmptyComponent={<Text style={styles.muted}>{t('review.confirmAll')}</Text>}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setSession(null)}
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>{t('action.cancel')}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy || session.blocking.length > 0}
            onPress={() => void approve()}
            style={[styles.button, (busy || session.blocking.length > 0) && styles.disabled]}
          >
            {busy ? (
              <ActivityIndicator color="#04120c" />
            ) : (
              <Text style={styles.buttonText}>{t('action.approve')}</Text>
            )}
          </Pressable>
        </View>
        {session.blocking.length > 0 && (
          <Text style={styles.muted}>{t('review.blockedByFields')}</Text>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{t('review.title')}</Text>
      {error && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={items}
        keyExtractor={(item) => item.document.id}
        contentContainerStyle={styles.list}
        refreshControl={undefined}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => void open(item.document.id)}
            style={styles.row}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{item.document.documentType}</Text>
              <Text style={styles.muted}>
                {item.confidence === null
                  ? t('review.needsReview')
                  : t('review.confidence', { percent: Math.round(item.confidence * 100) })}{' '}
                · {item.blockingFields.length} to check
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>{t('review.empty')}</Text>}
      />
      {busy && <ActivityIndicator color={colors.primary} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.md },
  title: { ...typography.title, marginBottom: spacing.xs },
  muted: { ...typography.muted },
  list: { gap: spacing.sm, paddingTop: spacing.md },
  empty: { ...typography.muted, textAlign: 'center', marginTop: spacing.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    gap: spacing.sm,
  },
  rowTitle: { ...typography.subtitle, textTransform: 'capitalize', marginBottom: 2 },
  chevron: { color: colors.textMuted, fontSize: 22 },
  field: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    gap: 2,
  },
  fieldLabel: { ...typography.muted },
  fieldValue: { ...typography.body },
  error: { ...typography.body, color: colors.danger, marginTop: spacing.sm },
  actions: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.md },
  button: {
    flex: 1,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  disabled: { opacity: 0.4 },
  buttonText: { ...typography.subtitle, color: '#04120c' },
  secondary: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  secondaryText: { ...typography.subtitle, color: colors.text },
});
