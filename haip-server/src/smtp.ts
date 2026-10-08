import nodemailer from 'nodemailer';
import { connect, type Socket } from 'node:net';
import { requireThat } from './errors.js';
import type { ServiceConfig } from './config.js';

export class SMTPTimeoutError extends Error {
  readonly smtpAccepted = 'unknown';

  constructor() {
    super('smtp_timeout');
    this.name = 'SMTPTimeoutError';
  }
}

export async function deliverSMTP(
  smtp: NonNullable<ServiceConfig['smtp']>,
  production: boolean,
  message: { to: string; subject: string; text: string },
): Promise<{ smtp_accepted: true; delivered_or_read: 'unknown' }> {
  const controller = new AbortController();
  const expires = performance.now() + 10000;
  let socket: Socket | undefined;
  let settled = false;
  const transport = nodemailer.createTransport({
    ...smtp,
    requireTLS: production,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
    dnsTimeout: 10000,
    getSocket(_options, callback) {
      if (settled || controller.signal.aborted || performance.now() >= expires) {
        callback(new SMTPTimeoutError());
        return;
      }
      let handedOver = false;
      try {
        socket = connect({ host: smtp.host, port: smtp.port, signal: controller.signal });
      } catch (error) {
        callback(error as Error);
        return;
      }
      socket.once('error', (error) => {
        if (!handedOver) {
          handedOver = true;
          callback(error);
        }
      });
      socket.once('connect', () => {
        if (handedOver) return;
        handedOver = true;
        if (settled || controller.signal.aborted || performance.now() >= expires) {
          socket?.destroy();
          callback(new SMTPTimeoutError());
          return;
        }
        // Nodemailer retains hostname verification, implicit TLS, STARTTLS and authentication on this owned socket.
        callback(null, { connection: socket });
      });
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        controller.abort();
        socket?.destroy();
        if (error) reject(error);
        else resolve();
      };
      // SMTP activity can reset inactivity timers indefinitely. The complete send has one absolute deadline.
      const deadline = setTimeout(
        () => finish(new SMTPTimeoutError()),
        Math.max(0, expires - performance.now()),
      );
      try {
        transport.sendMail(
          {
            from: smtp.from,
            ...message,
            disableFileAccess: true,
            disableUrlAccess: true,
          },
          (error, result) => {
            if (settled) return;
            if (performance.now() >= expires) finish(new SMTPTimeoutError());
            else if (error) finish(error);
            else {
              try {
                requireThat(result.accepted?.length, 503, 'smtp_not_accepted');
                finish();
              } catch (caught) {
                finish(caught);
              }
            }
          },
        );
      } catch (error) {
        finish(error);
      }
    });
    return { smtp_accepted: true, delivered_or_read: 'unknown' };
  } finally {
    controller.abort();
    socket?.destroy();
    transport.close();
  }
}
