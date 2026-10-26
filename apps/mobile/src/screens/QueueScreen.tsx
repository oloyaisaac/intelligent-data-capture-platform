import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { createTranslator } from '@idcp/shared';
import { colors, spacing, typography } from '../ui/theme';
import type { QueueItem, UploadQueue } from '../state/uploadQueue';

const t = createTranslator('en');

const STATUS_LABEL: Record<QueueItem['status'], string> = {
  pending: 'Waiting',
  uploading: t('capture.uploading'),
  uploaded: t('capture.uploaded'),
  failed: t('capture.failed'),
  needs_attention: 'Needs attention',
};

/**
 * Upload queue (MOB-003): shows exactly what has not reached the server, why it failed, and
 * offers a retry. Nothing is shown as uploaded until the server has acknowledged it.
 */
export function QueueScreen({
  queue,
  onOpenReview,
}: {
  queue: UploadQueue;
  onOpenReview?: () => void;
}): React.JSX.Element {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(() => {
    setItems(queue.snapshot());
  }, [queue]);

  useEffect(() => {
    reload();
  }, [reload]);

  const drain = useCallback(async () => {
    setRefreshing(true);
    try {
      await queue.drain();
      reload();
    } finally {
      setRefreshing(false);
    }
  }, [queue, reload]);

  const renderItem = ({ item }: { item: QueueItem }) => (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.file} numberOfLines={1}>
          {item.fileName}
        </Text>
        <Text style={styles.muted}>
          {STATUS_LABEL[item.status]}
          {item.attempts > 0 ? ` · ${item.attempts} attempt${item.attempts === 1 ? '' : 's'}` : ''}
        </Text>
        {item.lastError && (
          <Text style={styles.error} numberOfLines={2}>
            {item.lastError}
          </Text>
        )}
      </View>
      {(item.status === 'failed' || item.status === 'needs_attention') && (
        <Pressable
          accessibilityRole="button"
          onPress={() => void queue.retry(item.id).then(reload)}
          style={styles.retry}
        >
          <Text style={styles.retryText}>{t('action.retry')}</Text>
        </Pressable>
      )}
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('queue.title')}</Text>
        <Text style={styles.muted}>
          {queue.pendingCount() === 0
            ? t('queue.empty')
            : `${queue.pendingCount()} waiting to upload`}
        </Text>
      </View>

      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void drain()} />}
        ListEmptyComponent={<Text style={styles.empty}>{t('queue.empty')}</Text>}
        contentContainerStyle={styles.list}
      />

      <View style={styles.actions}>
        <Pressable accessibilityRole="button" onPress={() => void drain()} style={styles.button}>
          <Text style={styles.buttonText}>
            {refreshing ? t('capture.uploading') : t('action.retry')}
          </Text>
        </Pressable>
        {onOpenReview && (
          <Pressable accessibilityRole="button" onPress={onOpenReview} style={styles.secondary}>
            <Text style={styles.secondaryText}>{t('review.title')}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.md },
  header: { marginBottom: spacing.md },
  title: { ...typography.title, marginBottom: spacing.xs },
  muted: { ...typography.muted },
  list: { gap: spacing.sm },
  empty: { ...typography.muted, textAlign: 'center', marginTop: spacing.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    gap: spacing.sm,
  },
  rowMain: { flex: 1, gap: 2 },
  file: { ...typography.body },
  error: { ...typography.muted, color: colors.danger },
  retry: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  retryText: { color: colors.primary, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.md },
  button: {
    flex: 1,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
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
