import { request } from 'undici';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const BASE = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;

type SendOpts = {
  channel: 'signals' | 'logs';
  text: string;
  reply_to_message_id?: number;
  disable_notification?: boolean;
};

export async function sendMessage(opts: SendOpts): Promise<{ message_id: number } | null> {
  const chat_id =
    opts.channel === 'signals' ? config.TELEGRAM_CHANNEL_SIGNALS : config.TELEGRAM_CHANNEL_LOGS;

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
    return body.result ? { message_id: body.result.message_id } : null;
  } catch (err) {
    logger.error({ err, channel: opts.channel }, 'telegram request failed');
    return null;
  }
}
