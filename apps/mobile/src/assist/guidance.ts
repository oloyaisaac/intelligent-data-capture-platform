/**
 * VOICE-001 — camera guidance.
 *
 * Everything here is a pure function over the detector's output: no audio, no network, no platform
 * call. That is what makes "guidance works fully offline" true by construction rather than by
 * testing: the only input is a `Detection` and the only output is a sentence to show or speak.
 *
 * Two behaviours matter more than the wording:
 *   - **Hysteresis.** A cue must hold for a few frames before it is announced, so a hand moving
 *     across the page does not produce a stream of contradictory instructions.
 *   - **Cooldowns.** The same cue is not repeated within a window; being told "move closer" five
 *     times a second is worse than silence.
 */
import type { TranslationKey } from '@idcp/shared';
import type { Detection } from '../capture/edgeDetection';

export type GuidanceId =
  | 'searching'
  | 'hold_still'
  | 'move_closer'
  | 'move_away'
  | 'too_dark'
  | 'glare'
  | 'flat_contrast'
  | 'page_detected'
  | 'ready';

export interface GuidanceCue {
  id: GuidanceId;
  /** Translation key, so the same cue is spoken in the operator's language. */
  messageKey: TranslationKey;
  /** 0–3; the highest-priority cue is the one shown. */
  urgency: number;
  /** Announced aloud when voice is on; `ready` is announced once, `searching` never is. */
  speak: boolean;
}

export interface GuidanceOptions {
  /** Detections needed before a cue is announced. */
  stableFrames?: number;
  /** Minimum milliseconds between two announcements of the same cue. */
  cooldownMs?: number;
  /** Brightness below this is "too dark" to read reliably. */
  darkLuma?: number;
  /** Brightness above this is glare. */
  brightLuma?: number;
  /** Contrast below this produces a grey, unreadable scan. */
  flatContrast?: number;
  /** Area share below which the page is too small to read. */
  minAreaRatio?: number;
  /** Area share above which the page is cropped by the frame. */
  maxAreaRatio?: number;
}

const DEFAULTS: Required<GuidanceOptions> = {
  stableFrames: 3,
  cooldownMs: 4000,
  darkLuma: 60,
  brightLuma: 245,
  flatContrast: 18,
  minAreaRatio: 0.35,
  maxAreaRatio: 0.98,
};

/** The cue a single frame calls for, before stability and cooldowns are applied. */
export function cueFor(detection: Detection | null, options: GuidanceOptions = {}): GuidanceCue {
  const config = { ...DEFAULTS, ...options };
  if (!detection) return cue('searching');

  if (detection.meanLuma < config.darkLuma) return cue('too_dark');
  if (detection.meanLuma > config.brightLuma) return cue('glare');
  if (detection.areaRatio < config.minAreaRatio) return cue('move_closer');
  if (detection.areaRatio > config.maxAreaRatio) return cue('move_away');
  if (detection.contrast < config.flatContrast) return cue('flat_contrast');
  if (detection.confidence < 0.6) return cue('hold_still');
  if (detection.confidence < 0.85) return cue('page_detected');
  return cue('ready');
}

function cue(id: GuidanceId): GuidanceCue {
  switch (id) {
    case 'searching':
      return { id, messageKey: 'voice.cue.searching', urgency: 0, speak: false };
    case 'hold_still':
      return { id, messageKey: 'voice.cue.holdStill', urgency: 2, speak: true };
    case 'move_closer':
      return { id, messageKey: 'voice.cue.moveCloser', urgency: 2, speak: true };
    case 'move_away':
      return { id, messageKey: 'voice.cue.moveAway', urgency: 1, speak: true };
    case 'too_dark':
      return { id, messageKey: 'voice.cue.tooDark', urgency: 3, speak: true };
    case 'glare':
      return { id, messageKey: 'voice.cue.glare', urgency: 3, speak: true };
    case 'flat_contrast':
      return { id, messageKey: 'voice.cue.flatContrast', urgency: 1, speak: true };
    case 'page_detected':
      return { id, messageKey: 'voice.cue.pageDetected', urgency: 1, speak: true };
    case 'ready':
      return { id, messageKey: 'voice.cue.ready', urgency: 0, speak: true };
  }
}

export interface GuidanceState {
  /** The cue to show right now (never null: "searching" is a cue). */
  current: GuidanceCue;
  /** What to say, if anything: null means silence. */
  announce: GuidanceCue | null;
  /** Frames the current cue has held for. */
  stableFor: number;
}

export interface GuidanceTracker {
  observe(detection: Detection | null): GuidanceState;
  reset(): void;
}

/**
 * Feeds detections in and decides what to show and what to say.
 *
 * The tracker is stateful (it remembers the previous cue and when it last spoke) but wholly local;
 * `now` is injectable so tests need no clock.
 */
export function createGuidanceTracker(
  options: GuidanceOptions & { now?: () => number } = {},
): GuidanceTracker {
  const config = { ...DEFAULTS, ...options };
  const now = options.now ?? (() => Date.now());
  let current: GuidanceCue = cue('searching');
  let stableFor = 0;
  let readyAnnounced = false;
  const lastSpokenAt = new Map<GuidanceId, number>();

  return {
    observe(detection) {
      const next = cueFor(detection, options);

      if (next.id === current.id) {
        stableFor += 1;
      } else {
        current = next;
        stableFor = 1;
        if (next.id !== 'ready') readyAnnounced = false;
      }

      let announce: GuidanceCue | null = null;
      if (
        current.speak &&
        stableFor >= config.stableFrames &&
        // "Ready" is worth saying once per framing, not every four seconds forever.
        !(current.id === 'ready' && readyAnnounced)
      ) {
        const last = lastSpokenAt.get(current.id);
        const stamp = now();
        if (last === undefined || stamp - last >= config.cooldownMs) {
          lastSpokenAt.set(current.id, stamp);
          announce = current;
          if (current.id === 'ready') readyAnnounced = true;
        }
      }

      return { current, announce, stableFor };
    },
    reset() {
      current = cue('searching');
      stableFor = 0;
      readyAnnounced = false;
      lastSpokenAt.clear();
    },
  };
}
