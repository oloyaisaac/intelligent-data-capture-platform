/**
 * VOICE-001 — the review screen's spoken commands, as a pure reducer.
 *
 * A destructive command needs two utterances: the first arms a confirmation, the second runs it, and
 * anything else in between disarms. Keeping this out of the component means the rule "a misheard
 * approve does not file a record" is tested directly rather than through a rendered tree.
 */
import type { TranslationKey } from '@idcp/shared';
import { gate, type ParsedCommand, type VoiceCommandId } from './commands';

/** The "heard" line: either a catalogue key, or the phrase that matched plus its key. */
export interface HeardLine {
  key: TranslationKey;
  phrase?: string;
}

export interface VoiceSessionState {
  /** The destructive command waiting for a second confirmation. */
  armed: VoiceCommandId | null;
  /** The "heard" line to display. */
  heard: HeardLine | null;
}

export function initialVoiceSession(): VoiceSessionState {
  return { armed: null, heard: null };
}

export interface VoiceOutcome {
  state: VoiceSessionState;
  /** The command to run now; null when it needs confirming or nothing was understood. */
  run: VoiceCommandId | null;
  /** Translation key of the confirmation prompt. */
  confirm: TranslationKey | null;
  /** Translation key to speak back. */
  spoken: TranslationKey | null;
}

export function reduceVoice(
  state: VoiceSessionState,
  parsed: ParsedCommand | null,
  options: { listening: boolean },
): VoiceOutcome {
  const gated = gate(parsed, { listening: options.listening });
  if (!parsed) {
    return {
      state: { ...state, armed: null, heard: { key: 'voice.noMatch' } },
      run: null,
      confirm: null,
      spoken: null,
    };
  }
  if (gated.run) {
    return {
      state: { armed: null, heard: { key: 'voice.heard', phrase: parsed.matched } },
      run: gated.run,
      confirm: null,
      spoken: gated.spoken,
    };
  }
  if (!gated.confirm) {
    return {
      state: { ...state, armed: null, heard: gated.spoken ? { key: gated.spoken } : null },
      run: null,
      confirm: null,
      spoken: gated.spoken,
    };
  }

  // Already armed for this same destructive command: this is the confirmation.
  if (state.armed === parsed.command) {
    return {
      state: { armed: null, heard: { key: 'voice.heard', phrase: parsed.matched } },
      run: parsed.command,
      confirm: null,
      spoken: null,
    };
  }

  return {
    state: { armed: parsed.command, heard: { key: 'voice.heard', phrase: parsed.matched } },
    run: null,
    confirm: gated.confirm,
    spoken: gated.spoken,
  };
}
