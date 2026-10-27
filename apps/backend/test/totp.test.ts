import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totp,
  verifyTotp,
} from '../src/auth/totp';

/**
 * TOTP against the RFCs (DEC-034).
 *
 * The vectors are the point: the algorithm is trivial to write and easy to write subtly wrong —
 * base32 padding, the truncation offset, the big-endian counter — and every one of those mistakes
 * still produces plausible-looking six-digit numbers. These constants come from RFC 4226 Appendix D
 * and RFC 6238 Appendix B, so the implementation is checked against the specification rather than
 * against itself.
 */
describe('TOTP', () => {
  it('matches the RFC 4226 HOTP test vectors', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676'];
    expected.forEach((code, counter) => {
      expect(hotp(secret, counter)).toBe(code);
    });
  });

  it('matches the RFC 6238 SHA-1 vectors at six digits', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
    // RFC 6238 lists 8-digit values; the last six of each are what a 6-digit token shows.
    const cases: Array<[number, string]> = [
      [59_000, '287082'],
      [1_111_111_109_000, '081804'],
      [1_111_111_111_000, '050471'],
      [1_234_567_890_000, '005924'],
      [2_000_000_000_000, '279037'],
      [20_000_000_000_000, '353130'],
    ];
    for (const [at, code] of cases) expect(totp(secret, at)).toBe(code);
  });

  it('round-trips base32 without padding', () => {
    const bytes = Buffer.from('a secret of arbitrary length', 'utf8');
    const encoded = base32Encode(bytes);
    expect(encoded).not.toContain('=');
    expect(base32Decode(encoded).equals(bytes)).toBe(true);
    expect(() => base32Decode('not-base32!')).toThrow(/base32/);
  });

  it('accepts one step of drift and nothing more', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const current = totp(secret, now);
    expect(verifyTotp(secret, current, { at: now })).toBe(true);
    expect(verifyTotp(secret, totp(secret, now - 30_000), { at: now })).toBe(true);
    expect(verifyTotp(secret, totp(secret, now + 30_000), { at: now })).toBe(true);
    // Three steps away is a code from another minute: refused.
    expect(verifyTotp(secret, totp(secret, now + 90_000), { at: now })).toBe(false);
    expect(verifyTotp(secret, '000000', { at: now })).toBe(false);
    expect(verifyTotp(secret, 'abcdef', { at: now })).toBe(false);
  });

  it('builds a URI an authenticator app can read', () => {
    const uri = otpauthUri({
      secret: 'JBSWY3DPEHPK3PXP',
      account: 'owner@example.com',
      issuer: 'IDCP',
    });
    expect(uri.startsWith('otpauth://totp/IDCP%3Aowner%40example.com?')).toBe(true);
    const params = new URLSearchParams(uri.split('?')[1]);
    expect(params.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(params.get('issuer')).toBe('IDCP');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
  });

  it('generates a fresh 160-bit secret every time', () => {
    const first = generateTotpSecret();
    expect(first).toHaveLength(32);
    expect(base32Decode(first)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(first);
  });
});
