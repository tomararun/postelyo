import { createTransport, type Transporter } from 'nodemailer';
import type { Env } from '../config/env.js';
import type { Logger } from './logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Development/test transport: records messages and logs them (bodies may contain magic links). */
export class LogMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  constructor(private readonly logger?: Logger) {}

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    this.logger?.info(
      { to: message.to, subject: message.subject, text: message.text },
      'mail (log transport)',
    );
  }

  lastTo(email: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to.toLowerCase() === email.toLowerCase());
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;
  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = createTransport(smtpUrl);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

export function createMailer(env: Env, logger: Logger): Mailer {
  if (env.MAIL_TRANSPORT === 'smtp') {
    if (!env.SMTP_URL) throw new Error('SMTP_URL is required for the smtp mail transport');
    return new SmtpMailer(env.SMTP_URL, env.MAIL_FROM);
  }
  return new LogMailer(logger);
}
