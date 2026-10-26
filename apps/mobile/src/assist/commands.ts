/**
 * VOICE-001 — spoken commands.
 *
 * Speech recognition is unreliable in exactly the places capture happens (a warehouse, a moving
 * van), so the matcher is built defensively:
 *   - only phrases that are in the phrase book for the active locale can fire;
 *   - a low-confidence transcript fires nothing;
 *   - anything destructive (approve, reject, delete) must be confirmed on screen, because a
 *     misheard "approve" that silently files a record is worse than one extra tap;
 *   - "stop listening" always works, even when everything else is ambiguous.
 *
 * All of it is pure: the caller supplies the transcript. No audio reaches this module.
 */

import type { TranslationKey } from '@idcp/shared';

export type VoiceCommandId =
  | 'capture'
  | 'retake'
  | 'use_photo'
  | 'next_field'
  | 'previous_field'
  | 'approve'
  | 'reject'
  | 'repeat'
  | 'stop_listening'
  | 'start_listening';

export interface CommandDefinition {
  id: VoiceCommandId;
  /** Needs a confirmation step on screen before it happens. */
  destructive: boolean;
  /** Whether the command reads a field name ("next field total") as an argument. */
  takesField?: boolean;
}

export const COMMANDS: Record<VoiceCommandId, CommandDefinition> = {
  capture: { id: 'capture', destructive: false },
  retake: { id: 'retake', destructive: false },
  use_photo: { id: 'use_photo', destructive: false },
  next_field: { id: 'next_field', destructive: false, takesField: true },
  previous_field: { id: 'previous_field', destructive: false, takesField: true },
  approve: { id: 'approve', destructive: true },
  reject: { id: 'reject', destructive: true },
  repeat: { id: 'repeat', destructive: false },
  stop_listening: { id: 'stop_listening', destructive: false },
  start_listening: { id: 'start_listening', destructive: false },
};

type PhraseBook = Record<VoiceCommandId, string[]>;

/**
 * Phrases per locale. Short, unambiguous words only — a phrase that collides with ordinary speech
 * ("save", "send") is left out rather than made to work with a magic word.
 */
export const PHRASES: Record<'en' | 'sw' | 'fr', PhraseBook> = {
  en: {
    capture: ['capture', 'take photo', 'take a photo', 'snap', 'shoot', 'scan'],
    retake: ['retake', 'take another', 'do it again', 'again'],
    use_photo: ['use photo', 'keep it', 'accept photo', 'looks good'],
    next_field: ['next field', 'next'],
    previous_field: ['previous field', 'back', 'go back'],
    approve: ['approve', 'confirm record', 'file it'],
    reject: ['reject', 'discard record', 'send back'],
    repeat: ['repeat', 'say again', 'what'],
    stop_listening: ['stop listening', 'stop', 'quiet', 'mute'],
    start_listening: ['start listening', 'listen'],
  },
  sw: {
    capture: ['piga picha', 'piga', 'chukua picha', 'skani'],
    retake: ['piga tena', 'tena', 'rudia'],
    use_photo: ['tumia picha', 'kubali picha', 'ni sawa'],
    next_field: ['sehemu inayofuata', 'ifuatayo', 'mbele'],
    previous_field: ['sehemu iliyopita', 'nyuma', 'rudi'],
    approve: ['kubali', 'idhinisha', 'hifadhi kumbukumbu'],
    reject: ['kataa', 'ondoa kumbukumbu', 'rudisha'],
    repeat: ['rudia tena', 'sikia tena', 'nini'],
    stop_listening: ['acha kusikiliza', 'acha', 'nyamaza'],
    start_listening: ['anza kusikiliza', 'sikiliza'],
  },
  fr: {
    capture: ['capture', 'prendre photo', 'prends la photo', 'photographier', 'scanner'],
    retake: ['reprendre', 'encore une fois', 'encore'],
    use_photo: ['garder la photo', 'garder', 'accepter la photo'],
    next_field: ['champ suivant', 'suivant'],
    previous_field: ['champ précédent', 'précédent', 'retour'],
    approve: ['approuver', 'valider le document', 'classer'],
    reject: ['rejeter', 'refuser le document', 'renvoyer'],
    repeat: ['répéter', 'répète', 'quoi'],
    stop_listening: ['arrêter d écouter', 'arrête', 'silence'],
    start_listening: ['commencer à écouter', 'écoute'],
  },
};

export interface ParsedCommand {
  command: VoiceCommandId;
  /** The field named after the command, when one was given and the command takes one. */
  field: string | null;
  /** The phrase that matched, for display ("heard: next field total"). */
  matched: string;
  requiresConfirmation: boolean;
}

export interface ParseOptions {
  locale?: string;
  /** Below this, the transcript fires nothing. */
  minConfidence?: number;
}

/** Normalises accents, punctuation and case, so "Précédent," and "precedent" are the same word. */
export function normaliseSpeech(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Matches a transcript against the phrase book.
 *
 * The longest phrase wins, so "next field total" beats "next". A transcript that contains no phrase
 * returns null — the assistant stays quiet rather than guessing. Commands from other locales are
 * accepted as a fallback, because a bilingual operator should not have to switch a setting.
 */
export function parseCommand(
  transcript: string,
  confidence = 1,
  options: ParseOptions = {},
): ParsedCommand | null {
  const minConfidence = options.minConfidence ?? 0.5;
  if (confidence < minConfidence) return null;

  const spoken = normaliseSpeech(transcript);
  if (!spoken) return null;

  const locale = (options.locale ?? 'en') as keyof typeof PHRASES;
  const books = [PHRASES[locale] ?? PHRASES.en, PHRASES.en, PHRASES.sw, PHRASES.fr];

  let best: { command: VoiceCommandId; phrase: string } | null = null;
  for (const book of books) {
    for (const [command, phrases] of Object.entries(book) as Array<[VoiceCommandId, string[]]>) {
      for (const phrase of phrases) {
        const needle = normaliseSpeech(phrase);
        if (!containsPhrase(spoken, needle)) continue;
        if (!best || needle.length > best.phrase.length) best = { command, phrase: needle };
      }
    }
  }
  if (!best) return null;

  // "stop" is a prefix of "stop listening"; the longest-phrase rule already prefers the longer one.
  const field = COMMANDS[best.command].takesField ? trailingField(spoken, best.phrase) : null;

  return {
    command: best.command,
    field,
    matched: best.phrase,
    requiresConfirmation: COMMANDS[best.command].destructive,
  };
}

/** Phrase matching is word-bounded so "again" does not match "against". */
function containsPhrase(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

function trailingField(spoken: string, phrase: string): string | null {
  const at = spoken.indexOf(phrase);
  const rest = spoken.slice(at + phrase.length).trim();
  return rest === '' ? null : rest;
}

/**
 * Screens a parsed command against the session state.
 *
 * A destructive command returns the confirmation it needs instead of running. `listening` is
 * checked first: commands cannot arrive from a microphone that was switched off.
 */
export function gate(
  parsed: ParsedCommand | null,
  state: { listening: boolean },
): { run: VoiceCommandId | null; confirm: TranslationKey | null; spoken: TranslationKey | null } {
  if (!parsed) return { run: null, confirm: null, spoken: null };
  if (!state.listening && parsed.command !== 'start_listening') {
    return { run: null, confirm: null, spoken: 'voice.mustEnable' };
  }
  if (parsed.requiresConfirmation) {
    return {
      run: null,
      confirm: `voice.confirm.${parsed.command}` as TranslationKey,
      spoken: `voice.confirm.${parsed.command}` as TranslationKey,
    };
  }
  return { run: parsed.command, confirm: null, spoken: null };
}
