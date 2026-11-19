import nodemailer from 'nodemailer';
import type { Config } from '../config';
import type { Mailer } from '../services/mailer';

export function createMailer(config: Config): Mailer | null {
  if (config.MAIL_TRANSPORT === 'disabled') return null;
  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    // With port 587, refuse to send credentials or links unless STARTTLS succeeds. Tests may
    // exercise a local plaintext SMTP fixture; production and development never downgrade.
    requireTLS: !config.SMTP_SECURE && config.NODE_ENV !== 'test',
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  const send = async (to: string, subject: string, text: string): Promise<void> => {
    await transporter.sendMail({ from: config.MAIL_FROM, to, subject, text });
  };
  return {
    sendPasswordReset: (email, url) =>
      send(
        email,
        'Reset your IDCP password',
        `Use this one-time link to reset your password:\n\n${url}\n\nIf you did not request this, ignore this email.`,
      ),
    sendInvitation: (email, url) =>
      send(
        email,
        'Your IDCP invitation',
        `You have been invited to IDCP. Use this one-time link to accept:\n\n${url}`,
      ),
  };
}
