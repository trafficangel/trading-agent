import { request, FormData } from 'undici';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const BASE = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;

function chatId(channel: 'signals' | 'logs'): string {
  return channel === 'signals' ? config.TELEGRAM_CHANNEL_SIGNALS : config.TELEGRAM_CHANNEL_LOGS;
}

type SendOpts = {
  channel: 'signals' | 'logs';
  text: string;
  reply_to_message_id?: number;
  disable_notification?: boolean;
};

export async function sendMessage(opts: SendOpts): Promise<{ message_id: number } | null> {
  const chat_id = chatId(opts.channel);

  try {
    const res = await request(`${BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id,
        text: opts.text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_to_message_id: opts.reply_to_message_id,
        disable_notification: opts.disable_notification ?? false,
      }),
    });
    const body = (await res.body.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
    if (!body.ok) {
      logger.error({ channel: opts.channel, err: body.description }, 'telegram send failed');
      return null;
    }
    if (body.result) {
      logger.info({ channel: opts.channel, message_id: body.result.message_id }, 'telegram sent');
      return { message_id: body.result.message_id };
    }
    return null;
  } catch (err) {
    logger.error({ err, channel: opts.channel }, 'telegram request failed');
    return null;
  }
}

export type SendPhotoOpts = {
  channel: 'signals' | 'logs';
  /** absolute path to the PNG/JPEG file */
  photoPath: string;
  caption: string;
  reply_to_message_id?: number;
};

/** Send a photo with HTML caption. Caption max 1024 chars. */
export async function sendPhoto(opts: SendPhotoOpts): Promise<{ message_id: number } | null> {
  const buf = await readFile(opts.photoPath).catch((err) => {
    logger.error({ err, path: opts.photoPath }, 'sendPhoto: read failed');
    return null;
  });
  if (!buf) return null;

  const form = new FormData();
  form.append('chat_id', chatId(opts.channel));
  form.append('caption', opts.caption.slice(0, 1024));
  form.append('parse_mode', 'HTML');
  if (opts.reply_to_message_id) form.append('reply_to_message_id', String(opts.reply_to_message_id));
  const blob = new Blob([buf], { type: 'image/png' });
  form.append('photo', blob, basename(opts.photoPath));

  try {
    const res = await request(`${BASE}/sendPhoto`, { method: 'POST', body: form });
    const body = (await res.body.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
    if (!body.ok) {
      logger.error({ channel: opts.channel, err: body.description }, 'telegram sendPhoto failed');
      return null;
    }
    if (body.result) {
      logger.info({ channel: opts.channel, message_id: body.result.message_id }, 'telegram photo sent');
      return { message_id: body.result.message_id };
    }
    return null;
  } catch (err) {
    logger.error({ err, channel: opts.channel }, 'telegram photo request failed');
    return null;
  }
}
