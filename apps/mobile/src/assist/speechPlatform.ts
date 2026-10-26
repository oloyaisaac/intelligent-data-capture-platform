/**
 * VOICE-001 — the platform shim for speech, with the same honesty as the camera shim.
 *
 * Recognition and synthesis need native modules (`@react-native-voice/voice` and
 * `react-native-tts`), which are not installed in this repository's test environment. The shim
 * therefore:
 *
 *   - uses the module when it is present, asking for **text only** — the module is never given a
 *     file path or a recording option, so there is nothing to write to disk;
 *   - returns a recogniser that reports "unavailable" when the module is missing, so the UI can say
 *     so instead of failing mid-capture.
 *
 * The consent rules, the command grammar and the guidance logic are pure and tested without any of
 * this (`consent.ts`, `commands.ts`, `guidance.ts`).
 */
import type { VoiceAssistantPlatform } from './consent';

/* eslint-disable @typescript-eslint/no-require-imports */
function optionalRequire<T>(name: string): T | null {
  try {
    return require(name) as T;
  } catch {
    return null;
  }
}

interface VoiceModule {
  start: (locale: string) => Promise<void>;
  stop: () => Promise<void>;
  onSpeechResults: (handler: (event: { value?: string[] }) => void) => void;
  onSpeechPartialResults?: (handler: (event: { value?: string[] }) => void) => void;
  removeAllListeners?: () => void;
}

interface TtsModule {
  speak: (text: string) => void;
  stop: () => void;
  setDefaultLanguage?: (locale: string) => void;
}

const voice = optionalRequire<VoiceModule>('@react-native-voice/voice');
const tts = optionalRequire<TtsModule>('react-native-tts');

/** Whether this build can recognise speech. */
export function speechAvailable(): boolean {
  return Boolean(voice?.start);
}

/** Whether this build can speak guidance aloud. */
export function speechOutputAvailable(): boolean {
  return Boolean(tts?.speak);
}

/** BCP-47 tags for the catalogue locales; the recogniser needs a region-less tag to be portable. */
const SPEECH_LOCALES: Record<string, string> = { en: 'en-US', sw: 'sw-KE', fr: 'fr-FR' };

export interface SpeechPlatformOptions {
  locale?: string;
  /** How long to wait for a transcript before giving up. */
  timeoutMs?: number;
}

/**
 * The platform adapter handed to `createVoiceAssistant`.
 *
 * `listen()` completes with a transcript and nothing else: the recogniser's events carry text, and
 * this function never returns an audio path, buffer or recording.
 */
export function createSpeechPlatform(options: SpeechPlatformOptions = {}): VoiceAssistantPlatform {
  const locale = SPEECH_LOCALES[options.locale ?? 'en'] ?? 'en-US';
  const timeoutMs = options.timeoutMs ?? 5000;

  return {
    listen() {
      const module = voice;
      if (!module) return Promise.reject(new Error('voice.unavailable'));
      return new Promise((resolve, reject) => {
        const finish = (transcript: string) => {
          module.removeAllListeners?.();
          resolve({ transcript, confidence: transcript ? 1 : 0 });
        };
        const timer = setTimeout(() => {
          module.stop().catch(() => undefined);
          finish('');
        }, timeoutMs);
        module.onSpeechResults((event) => {
          clearTimeout(timer);
          finish(event.value?.[0] ?? '');
        });
        module.start(locale).catch((error: unknown) => {
          clearTimeout(timer);
          module.removeAllListeners?.();
          reject(error instanceof Error ? error : new Error('voice.unavailable'));
        });
      });
    },
    speak(text) {
      if (!tts?.speak) return;
      tts.stop?.();
      tts.speak(text);
    },
    requestMicrophone() {
      // The OS permission dialog is owned by the recogniser; asking it to start is the request.
      // With no module there is no permission to grant, and the caller keeps the mic closed.
      return Promise.resolve(speechAvailable());
    },
  };
}
