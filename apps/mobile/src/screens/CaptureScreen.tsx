import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import { createTranslator, type Locale } from '@idcp/shared';
import { colors, spacing, typography } from '../ui/theme';
import type { UploadQueue } from '../state/uploadQueue';
import { processCapture, type ImageTransformer } from '../capture/imagePipeline';
import { useDocumentDetector, type FrameBridge } from '../capture/useDocumentDetector';
import { scaleQuad } from '../capture/edgeDetection';
import { DocumentFrameProcessor } from '../capture/frameProcessor';
import { createGuidanceTracker, type GuidanceTracker } from '../assist/guidance';
import { canListen, listenBlocker, type VoiceAssistant } from '../assist/consent';

/**
 * Capture (MOB-001, MOB-002, MOB-003): frame the page, take a photo, queue it, then upload.
 *
 * The capture is written to the queue *before* any network call, so nothing is lost if the phone
 * is offline, the app is closed, or the upload fails. The queue item id doubles as the upload
 * idempotency key, so a retry can never create a duplicate record on the server.
 *
 * MOB-002: when a frame bridge is supplied (the app wires it to a VisionCamera frame processor), the
 * detected page outline is drawn as an overlay and used as the crop for the photo. Without it the
 * screen still captures — the plan simply has no quad — so the app degrades rather than blocks.
 */
export function CaptureScreen({
  queue,
  onCaptured,
  transformer,
  frameSize,
  bridge,
  guidance,
  voice,
  locale = 'en',
}: {
  queue: UploadQueue;
  onCaptured?: (documentId: string) => void;
  /** MOB-002: the platform image toolkit; without it the raw photo is queued. */
  transformer?: ImageTransformer;
  frameSize?: { width: number; height: number };
  /** MOB-002: detector output from the camera frames; see useDocumentDetector.ts. */
  bridge?: FrameBridge;
  /** VOICE-001: the guidance tracker; created locally when one is not supplied. */
  guidance?: GuidanceTracker;
  /** VOICE-001: voice consent + speech; without it the screen is silent and the switch is hidden. */
  voice?: VoiceAssistant;
  locale?: Locale;
}): React.JSX.Element {
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const camera = useRef<Camera>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [planSteps, setPlanSteps] = useState<string[]>([]);
  const detection = bridge ? useDocumentDetector(bridge) : null;
  const [frameProcessor, setFrameProcessor] = useState<unknown>(null);
  const [tracker] = useState(() => guidance ?? createGuidanceTracker());
  const [cue, setCue] = useState(() => tracker.observe(null).current);
  const [voiceSettings, setVoiceSettings] = useState(() => voice?.settings() ?? null);

  useEffect(() => {
    if (!hasPermission) void requestPermission();
  }, [hasPermission, requestPermission]);

  useEffect(() => {
    setPending(queue.pendingCount());
  }, [queue, message]);

  // VOICE-001: guidance is derived from the detector's output alone, so it keeps working with the
  // network down — the cue is computed locally and only the wording comes from the catalogue.
  useEffect(() => {
    const state = tracker.observe(detection);
    setCue(state.current);
    if (state.announce && voice) void voice.say(t(state.announce.messageKey));
  }, [detection, tracker, voice]);

  const toggleVoice = useCallback(async () => {
    if (!voice) return;
    const next = await voice.set('enabled', !voice.settings().enabled);
    setVoiceSettings(next);
    if (!next.enabled) setMessage(t(listenBlocker(next) ?? 'voice.notListening'));
  }, [voice]);

  const capture = useCallback(async () => {
    if (!camera.current || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const photo = await camera.current.takePhoto({ flash: 'auto' });
      const id = `cap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      // The outline is found on the preview frames, so scale it to the photo's resolution.
      const previewQuad = detection?.quad ?? null;
      const photoOrientation = Number(photo.metadata?.Orientation ?? 1);

      // MOB-002: crop to the detected page, straighten the contrast, then shrink for upload.
      // If no transformer is supplied (or any step fails) the original file is queued unchanged.
      let uri = `file://${photo.path}`;
      if (transformer) {
        const photoSize = { width: photo.width, height: photo.height };
        const processed = await processCapture(transformer, uri, {
          frame: frameSize ?? photoSize,
          quad: previewQuad ? scaleQuad(previewQuad, frameSize ?? photoSize, photoSize) : null,
          orientation: photoOrientation,
          // A flat frame (shadow across the page, dim overhead light) gets a contrast pass. The
          // threshold is the point where a reviewer would call the scan "too grey to read".
          washedOut: detection ? detection.contrast < 30 : false,
          estimatedBytes: photo.width * photo.height * 0.35,
          options: { targetLongEdge: 1600, maxBytes: 2 * 1024 * 1024 },
        });
        uri = processed.uri;
        setPlanSteps(processed.plan.steps);
      }

      await queue.enqueue({
        id,
        uri,
        fileName: `${id}.jpg`,
        mimeType: 'image/jpeg',
      });
      setPending(queue.pendingCount());
      setMessage(t('capture.queued'));

      const processed = await queue.drain();
      const result = processed.find((item) => item.id === id);
      if (result?.status === 'uploaded' && result.documentId) {
        setMessage(t('capture.uploaded'));
        onCaptured?.(result.documentId);
      } else if (result?.status === 'failed') {
        setMessage(t('capture.failed'));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('error.generic'));
    } finally {
      setBusy(false);
      setPending(queue.pendingCount());
    }
  }, [busy, detection, frameSize, onCaptured, queue, t, transformer]);

  if (!hasPermission) {
    return (
      <View style={styles.centered}>
        <Text style={styles.title}>{t('pairing.permissionDenied')}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void requestPermission()}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{t('action.continue')}</Text>
        </Pressable>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.centered}>
        <Text style={styles.title}>{t('capture.title')}</Text>
        <Text style={styles.muted}>This device has no camera available.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {bridge && <DocumentFrameProcessor bridge={bridge} onProcessor={setFrameProcessor} />}
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        photo
        {...(frameProcessor
          ? {
              frameProcessor: frameProcessor as React.ComponentProps<
                typeof Camera
              >['frameProcessor'],
            }
          : {})}
      />
      <View style={styles.guide} pointerEvents="none">
        <Text style={styles.guideText}>{t('capture.guide')}</Text>
        <Text style={styles.guideText} accessibilityLiveRegion="polite">
          {t(cue.messageKey)}
        </Text>
        {detection && (
          <Text style={styles.guideText}>
            Page detected · {Math.round(detection.confidence * 100)}%
          </Text>
        )}
      </View>

      <View style={styles.footer}>
        {message && <Text style={styles.message}>{message}</Text>}
        {planSteps.length > 0 && (
          <Text style={styles.muted} numberOfLines={2}>
            {planSteps.join(' · ')}
          </Text>
        )}
        {pending > 0 && <Text style={styles.muted}>{pending} waiting to upload</Text>}
        {voice && voiceSettings && (
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: voiceSettings.enabled }}
            accessibilityLabel={t('voice.enable')}
            onPress={() => void toggleVoice()}
            style={styles.voiceToggle}
          >
            <Text style={styles.guideText}>
              {canListen(voiceSettings)
                ? t('voice.listening')
                : t(listenBlocker(voiceSettings) ?? 'voice.notListening')}
            </Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('capture.takePhoto')}
          onPress={() => void capture()}
          disabled={busy}
          style={[styles.shutter, busy && styles.shutterBusy]}
        >
          {busy ? (
            <ActivityIndicator color="#04120c" />
          ) : (
            <Text style={styles.shutterText}>{t('capture.takePhoto')}</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  title: { ...typography.subtitle, textAlign: 'center' },
  muted: { ...typography.muted },
  voiceToggle: { alignSelf: 'center', paddingVertical: spacing.xs },
  guide: {
    position: 'absolute',
    top: '12%',
    left: '8%',
    right: '8%',
    bottom: '26%',
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,0.6)',
    borderRadius: 12,
    justifyContent: 'flex-start',
    padding: spacing.sm,
  },
  guideText: { color: '#fff', fontSize: 13, textAlign: 'center' },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing.md,
    gap: spacing.sm,
  },
  message: { color: '#fff', fontSize: 14, textAlign: 'center' },
  shutter: {
    backgroundColor: colors.primary,
    borderRadius: 32,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  shutterBusy: { opacity: 0.6 },
  shutterText: { ...typography.subtitle, color: '#04120c' },
  button: { backgroundColor: colors.primary, borderRadius: 12, padding: spacing.md },
  buttonText: { ...typography.subtitle, color: '#04120c' },
});
