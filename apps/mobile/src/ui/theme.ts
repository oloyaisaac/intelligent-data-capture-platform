/** Design tokens. Screens must not hardcode colours or spacing (AI.md §5). */
export const colors = {
  background: '#0f1720',
  surface: '#18232e',
  surfaceRaised: '#22303d',
  border: '#2f3f4f',
  text: '#f2f6fa',
  textMuted: '#9fb0c0',
  primary: '#2f9e77',
  primaryPressed: '#267f60',
  danger: '#d0554b',
  warning: '#d9a441',
  success: '#3ea97a',
  overlay: 'rgba(0,0,0,0.6)',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radius = { sm: 6, md: 12, lg: 20 } as const;

export const typography = {
  title: { fontSize: 26, fontWeight: '700' as const, color: colors.text },
  subtitle: { fontSize: 18, fontWeight: '600' as const, color: colors.text },
  body: { fontSize: 15, color: colors.text },
  muted: { fontSize: 13, color: colors.textMuted },
  mono: { fontSize: 14, color: colors.text, fontFamily: 'Courier' },
} as const;

/** Confidence colours used by review UI: never rely on colour alone (accessibility). */
export function confidenceColor(confidence: number): string {
  if (confidence >= 0.85) return colors.success;
  if (confidence >= 0.6) return colors.warning;
  return colors.danger;
}
