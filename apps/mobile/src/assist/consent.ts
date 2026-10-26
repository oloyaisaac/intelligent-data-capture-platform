/**
 * VOICE-001 — consent and the audio policy.
 *
 * The platform promise is narrow and checkable: **no audio is stored or transmitted without
 * consent**, and by default it is neither. The recogniser is therefore asked for a transcript only;
 * `retainTranscript` is a separate, off-by-default decision, and there is no code path in this module
 * that can persist an audio buffer at all.
 *
 * `createVoiceAssistant` is the only place the microphone is touched, and it refuses to open while
 * consent is missing — so "voice commands can be disabled" is a property of the object the screens
 * hold, not a convention.
 */

import type { TranslationKey } from '@idcp/shared';

export interface VoiceSettings {
  /** The operator turned voice on. Off by default, on every device, always. */
  enabled: boolean;
  /** The OS microphone permission was granted. */
  microphoneGranted: boolean;
  /** Speak guidance and confirmation prompts aloud. */
  spokenGuidance: boolean;
  /**
   * Keep the transcribed text for the review screen's "heard" line. Text only: audio is never kept,
   * so this switch cannot turn audio retention on.
   */
  retainTranscript: boolean;
}

export type VoiceToggle = keyof Omit<VoiceSettings, 'microphoneGranted'>;

export function defaultVoiceSettings(): VoiceSettings {
  return {
    enabled: false,
    microphoneGranted: false,
    spokenGuidance: true,
    retainTranscript: false,
  };
}

/** What the microphone may do right now. */
export function canListen(settings: VoiceSettings): boolean {
  return settings.enabled && settings.microphoneGranted;
}

/** Human-readable reason why the microphone is closed, or null when it is open. */
export function listenBlocker(settings: VoiceSettings): TranslationKey | null {
  if (!settings.enabled) return 'voice.blocked.disabled';
  if (!settings.microphoneGranted) return 'voice.blocked.permission';
  return null;
}

/**
 * Applies a toggle, keeping the operator's intent separate from what the microphone may do.
 *
 * `enabled` records that they asked for voice; `canListen` is the safety gate that also needs the
 * permission. Keeping them apart means a refused permission shows "permission needed" rather than
 * silently flipping the switch back, and turning voice off also stops transcript retention.
 */
export function applyToggle(
  settings: VoiceSettings,
  toggle: VoiceToggle,
  value: boolean,
): VoiceSettings {
  const next: VoiceSettings = { ...settings, [toggle]: value };
  if (toggle === 'enabled' && !value) next.retainTranscript = false;
  return next;
}

/** Records the OS permission result; a revoked permission also gives up kept command text. */
export function setMicrophoneGranted(settings: VoiceSettings, granted: boolean): VoiceSettings {
  return {
    ...settings,
    microphoneGranted: granted,
    retainTranscript: granted ? settings.retainTranscript : false,
  };
}

/** The sentence to show next to the switch. It never claims more than the code above does. */
export const AUDIO_POLICY = {
  audioStored: false,
  audioTransmitted: false,
  transcriptStoredByDefault: false,
  onDeviceRecognitionRequired: true,
} as const;

export function describeAudioPolicy(): string {
  return (
    'Voice is off until you turn it on. When it is on, speech is recognised on the device and only ' +
    'the text of a command is used; audio is never recorded, stored or uploaded. Turning voice off ' +
    'discards the kept command text.'
  );
}

/**
 * Strips anything audio-shaped out of a recogniser result.
 *
 * The recogniser interface has no audio field on purpose; this guard exists so a platform adapter
 * written by someone else cannot leak one into the app's state by widening the type.
 */
export function transcriptOnly<T extends { transcript: string; confidence?: number }>(
  result: T & { audio?: unknown },
): { transcript: string; confidence: number } {
  return {
    transcript: result.transcript,
    confidence: typeof result.confidence === 'number' ? result.confidence : 1,
  };
}

export interface VoiceAssistantPlatform {
  /** Opens the recogniser for one utterance and resolves with a transcript. */
  listen(): Promise<{ transcript: string; confidence?: number; audio?: unknown }>;
  /** Speaks a phrase; a no-op when speech output is unavailable. */
  speak(text: string): Promise<void> | void;
  /** Requests the OS microphone permission. */
  requestMicrophone(): Promise<boolean>;
}

export interface VoiceAssistant {
  settings(): VoiceSettings;
  /** Turns a switch over, asking for the microphone permission when it is needed. */
  set(toggle: VoiceToggle, value: boolean): Promise<VoiceSettings>;
  /** One listening turn; returns null when the microphone is closed or nothing was said. */
  hear(): Promise<{ transcript: string; confidence: number } | null>;
  say(text: string): Promise<void>;
  /** Remembers a command's text for the "heard" line, only when retention is on. */
  remember(text: string): string | null;
}

export function createVoiceAssistant(
  platform: VoiceAssistantPlatform,
  initial: VoiceSettings = defaultVoiceSettings(),
): VoiceAssistant {
  let current = { ...initial };
  let kept: string | null = null;

  return {
    settings: () => ({ ...current }),
    async set(toggle, value) {
      if (toggle === 'enabled' && value && !current.microphoneGranted) {
        const granted = await platform.requestMicrophone();
        current = setMicrophoneGranted(current, granted);
      }
      current = applyToggle(current, toggle, value);
      if (!current.enabled) kept = null;
      return { ...current };
    },
    async hear() {
      if (!canListen(current)) return null;
      // Nothing is started while the microphone is closed: no prompt, no recogniser, no audio.
      const result = await platform.listen();
      const clean = transcriptOnly(result);
      return clean.transcript.trim() === '' ? null : clean;
    },
    async say(text) {
      if (!current.spokenGuidance || !canListen(current)) return;
      await platform.speak(text);
    },
    remember(text) {
      if (!current.retainTranscript) return null;
      kept = text;
      return kept;
    },
  };
}
