import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { db, id, timestamp } from '../database/store.js';

const createRecord = () => {
  const message = {
    id: id(),
    provider: env.emailProvider,
    status: 'queued',
    createdAt: timestamp(),
  };
  db.emailMessages.push(message);
  return message;
};

const mark = (message, status, details = {}) => 
  Object.assign(message, {
    status,
    ...details,
    updatedAt: timestamp(),
  });


export const sendEmail = async ({ to, subject, text, html }) => {
  const message = createRecord();

  try {
    if (env.emailProvider === 'resend' && env.resendApiKey) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: env.emailFrom,
          to: [to],
          subject,
          text,
          html,
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message || 'Resend email failed');
      }

      return mark(message, 'sent', { providerMessageId: payload.id });
    }

    if (env.emailProvider === 'smtp' && env.smtpHost && env.smtpUser && env.smtpPassword) {
      const transporter = nodemailer.createTransport({
        host: env.smtpHost,
        port: env.smtpPort,
        secure: env.smtpSecure,
        auth: {
          user: env.smtpUser,
          pass: env.smtpPassword,
        },
      });

      const info = await transporter.sendMail({
        from: env.emailFrom,
        to,
        subject,
        text,
        html,
      });

      return mark(message, 'sent', { providerMessageId: info.messageId });
    }

    return mark(message, 'preview');
  } catch (error) {
    mark(message, 'failed', { error: 'Email delivery failed' });
    throw error;
  }
};


export const passwordResetEmail = ({ name, token }) => {
  const link = `${env.appPublicUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
  
  return {
    subject: 'Reset your SwitchRide password',
    text: `Hello ${name || 'there'},\n\nUse this link to reset your SwitchRide password. It expires in 30 minutes and can only be used once:\n${link}\n\nIf you did not request this, you can ignore this email.`,
    html: `
      <p>Hello ${name || 'there'},</p>
      <p>Use the button below to reset your SwitchRide password. This link expires in <strong>30 minutes</strong> and can only be used once.</p>
      <p><a href="${link}" style="background:#1aa477;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none">Reset password</a></p>
      <p>If you did not request this, you can ignore this email.</p>
    `,
  };
};

export const otpEmail = ({ code, purpose }) => ({
  subject: `Your SwitchRide ${purpose.replace('_', ' ')} code`,
  text: `Your SwitchRide verification code is ${code}. It expires in 5 minutes and can only be used once.`,
  html: `
    <p>Your SwitchRide verification code is:</p>
    <p style="font-size:28px;font-weight:700;letter-spacing:5px">${code}</p>
    <p>This code expires in 5 minutes and can only be used once.</p>
  `,
});

export const paymentReceiptEmail = ({ name, amount, reference }) => ({
  subject: 'SwitchRide payment receipt',
  text: `Hello ${name || 'there'}, your payment of NGN ${Number(amount).toLocaleString()} was successful. Reference: ${reference}.`,
  html: `
    <p>Hello ${name || 'there'},</p>
    <p>Your payment of <strong>NGN ${Number(amount).toLocaleString()}</strong> was successful.</p>
    <p>Reference: ${reference}</p>
  `,
});