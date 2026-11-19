/** Delivers one-time links without exposing tokens to logs. SMTP acceptance is not a delivery receipt. */
export interface Mailer {
  sendPasswordReset(email: string, url: string): Promise<void>;
  sendInvitation(email: string, url: string): Promise<void>;
}
