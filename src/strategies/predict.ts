import type { FastifyInstance } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageShell } from './landing.js';

/**
 * Public read-only page for the /predict track (robotclaude.biz/predict).
 *
 * The /predict track is an experimental Polymarket BTC Up/Down (5m)
 * strategy sandbox, deliberately ISOLATED from this Bybit trading-agent:
 * separate codebase, separate process, separate (eventual) wallet. This
 * site only ever DISPLAYS the track's public log — it never controls the
 * engine and never shares strategy params or keys.
 *
 * Data contract: a separate process writes a JSON status artifact (equity
 * curve, win rate, profit factor, rounds, phase — no private strategy
 * params). We read it at request time. Path is configurable via
 * PREDICT_STATUS_PATH so the producer can live anywhere on the box.
 */

const moduleDir = dirname(fileURLToPath(import.meta.url));
// dist/strategies/predict.js → repo root is two levels up.
const DEFAULT_STATUS_PATH = join(moduleDir, '..', '..', 'data', 'predict-status.json');
const STATUS_PATH = process.env.PREDICT_STATUS_PATH ?? DEFAULT_STATUS_PATH;

type EquityPoint = { t: number | null; slug: string; pnl: number; cumulative: number };
type RecentRound = { t: number | null; side: 'UP' | 'DOWN' | null; pnl: number; win: boolean };

type PredictStatus = {
  updatedAt: string;
  phase: { number: number; label: string };
  mode: string;
  rounds: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  maxDrawdown: number;
  marketOutcomes: { up: number; down: number };
  lastRoundAt?: number | null;
  recentRounds?: RecentRound[];
  equityCurve: EquityPoint[];
};

function readStatus(): PredictStatus | null {
  try {
    if (!existsSync(STATUS_PATH)) return null;
    return JSON.parse(readFileSync(STATUS_PATH, 'utf8')) as PredictStatus;
  } catch {
    return null;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function fmtUsd(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

/** Inline SVG equity curve — no external chart lib (CSP blocks third-party). */
function equitySvg(points: EquityPoint[]): string {
  if (points.length < 2) {
    return `<div class="pd-empty-chart">Недостаточно данных для кривой (нужно ≥2 раунда).</div>`;
  }
  const W = 720;
  const H = 220;
  const PAD = 24;
  const ys = points.map((p) => p.cumulative);
  const min = Math.min(0, ...ys);
  const max = Math.max(0, ...ys);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - 2 * PAD);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.cumulative).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(H - PAD).toFixed(1)} L${x(0).toFixed(1)},${(H - PAD).toFixed(1)} Z`;
  const zeroY = y(0).toFixed(1);
  const last = points[points.length - 1]!;
  const stroke = last.cumulative >= 0 ? '#4ad991' : '#e5616c';
  const fill = last.cumulative >= 0 ? 'rgba(74,217,145,0.12)' : 'rgba(229,97,108,0.12)';
  return (
    `<svg viewBox="0 0 ${W} ${H}" class="pd-chart" role="img" aria-label="Кривая накопленного PnL">` +
    `<line x1="${PAD}" y1="${zeroY}" x2="${W - PAD}" y2="${zeroY}" stroke="#2a313c" stroke-width="1" stroke-dasharray="4 4"/>` +
    `<path d="${area}" fill="${fill}" stroke="none"/>` +
    `<path d="${line}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.cumulative).toFixed(1)}" r="4" fill="${stroke}"/>` +
    `</svg>`
  );
}

function statCard(label: string, value: string, accent?: 'pos' | 'neg' | 'muted'): string {
  const cls = accent ? ` pd-stat-${accent}` : '';
  return `<div class="pd-stat${cls}"><div class="pd-stat-val">${value}</div><div class="pd-stat-lbl">${esc(label)}</div></div>`;
}

function agoText(ms: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 90) return `${sec} сек назад`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min} мин назад`;
  return `${Math.round(min / 60)} ч назад`;
}

/** Pill: онлайн (данные свежие, < 10 мин) / устаревшие. */
function freshnessPill(updatedAt: string): string {
  const ts = Date.parse(updatedAt);
  const fresh = Number.isFinite(ts) && Date.now() - ts < 10 * 60 * 1000;
  const cls = fresh ? 'pd-fresh-ok' : 'pd-fresh-stale';
  const label = fresh ? `онлайн · обновлено ${agoText(ts)}` : `данные устарели · ${agoText(ts)}`;
  return `<span class="pd-fresh ${cls}"><span class="pd-dot"></span>${esc(label)}</span>`;
}

function recentRoundsTable(rounds: RecentRound[]): string {
  if (rounds.length === 0) return '';
  const rows = rounds
    .map((r) => {
      const when = r.t ? agoText(r.t) : '—';
      const side = r.side ?? '—';
      const sideCls = r.side === 'UP' ? 'pd-up' : r.side === 'DOWN' ? 'pd-down' : '';
      const res = r.win ? 'выигрыш' : 'проигрыш';
      const resCls = r.win ? 'pd-pos' : 'pd-neg';
      return (
        `<tr><td class="${sideCls}">${esc(side)}</td>` +
        `<td class="${resCls}">${res}</td>` +
        `<td class="${resCls}" style="text-align:right">${fmtUsd(r.pnl)}</td>` +
        `<td class="pd-muted-td" style="text-align:right">${esc(when)}</td></tr>`
      );
    })
    .join('');
  return (
    `<div class="pd-card"><h2>Последние раунды</h2>` +
    `<table class="pd-table"><thead><tr><th>Сторона</th><th>Исход</th>` +
    `<th style="text-align:right">PnL</th><th style="text-align:right">Когда</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`
  );
}

function renderBody(s: PredictStatus | null): string {
  const styles = `<style>
    .pd-wrap{max-width:860px;margin:0 auto;padding:32px 20px 64px;color:#e6e9ef}
    .pd-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px}
    .pd-head h1{font-size:28px;margin:0;color:#fff}
    .pd-badge{font-size:13px;font-weight:600;padding:4px 10px;border-radius:999px;background:rgba(74,217,145,0.15);color:#4ad991;border:1px solid rgba(74,217,145,0.3)}
    .pd-fresh{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;padding:3px 9px;border-radius:999px}
    .pd-fresh-ok{background:rgba(74,217,145,0.12);color:#4ad991}
    .pd-fresh-stale{background:rgba(229,180,97,0.14);color:#e5b461}
    .pd-dot{width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block}
    .pd-sub{color:#9aa4b2;font-size:15px;line-height:1.55;margin:0 0 24px}
    .pd-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}
    .pd-stat{background:#11151c;border:1px solid #1e2530;border-radius:12px;padding:16px}
    .pd-stat-val{font-size:24px;font-weight:700;color:#fff}
    .pd-stat-lbl{font-size:12px;color:#8b95a4;margin-top:4px;text-transform:uppercase;letter-spacing:.04em}
    .pd-stat-pos .pd-stat-val{color:#4ad991}
    .pd-stat-neg .pd-stat-val{color:#e5616c}
    .pd-stat-muted .pd-stat-val{color:#9aa4b2}
    .pd-card{background:#11151c;border:1px solid #1e2530;border-radius:12px;padding:20px;margin-bottom:20px}
    .pd-card h2{font-size:15px;margin:0 0 14px;color:#cfd6e0;text-transform:uppercase;letter-spacing:.04em}
    .pd-chart{width:100%;height:auto;display:block}
    .pd-empty-chart{color:#8b95a4;text-align:center;padding:32px 0}
    .pd-foot{color:#6b7484;font-size:13px;margin-top:8px}
    .pd-note{background:rgba(74,217,145,0.06);border:1px solid rgba(74,217,145,0.18);border-radius:12px;padding:14px 16px;color:#9aa4b2;font-size:13.5px;line-height:1.5}
    .pd-empty{text-align:center;padding:40px 16px;color:#9aa4b2;line-height:1.6}
    .pd-table{width:100%;border-collapse:collapse;font-size:14px}
    .pd-table th{text-align:left;color:#8b95a4;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em;padding:6px 8px;border-bottom:1px solid #1e2530}
    .pd-table td{padding:8px;border-bottom:1px solid #161b22}
    .pd-pos{color:#4ad991}.pd-neg{color:#e5616c}.pd-up{color:#4ad991}.pd-down{color:#e5616c}.pd-muted-td{color:#6b7484}
  </style>`;

  // Шапка с pill фазы и индикатором свежести данных.
  const header = (status: PredictStatus | null): string =>
    `<div class="pd-head"><h1>/predict</h1>` +
    (status ? `<span class="pd-badge">Фаза ${status.phase.number} · ${esc(status.phase.label)}</span>` : '') +
    (status ? freshnessPill(status.updatedAt) : '') +
    `</div>`;

  const intro =
    `<p class="pd-sub">Эксперимент по prediction-market стратегиям на Polymarket (BTC Up/Down 5m). ` +
    `Эдж — в скорости, не в предсказании. Честный публичный лог: убытки тоже показываем. ` +
    `Изолировано от основного бота — это только просмотр.</p>`;

  const paperNote =
    `<div class="pd-note">⚠ Paper-режим (симуляция). Это валидация гипотезы, а не доказанная прибыльность: ` +
    `эдж считается реальным только после статистической проверки на большой выборке с учётом проскальзывания. ` +
    `Параметры стратегии не публикуются.</div>`;

  // Нет файла статуса вообще — трек ещё не публикует данные.
  if (!s) {
    return (
      styles +
      `<div class="pd-wrap">${header(null)}${intro}` +
      `<div class="pd-empty">Данные ещё не публикуются — трек на ранней фазе. Загляните позже.</div>` +
      `</div>`
    );
  }

  // Движок работает, но завершённых раундов ещё нет — честный empty-state
  // вместо сетки нулей.
  if (s.rounds === 0) {
    return (
      styles +
      `<div class="pd-wrap">${header(s)}${intro}` +
      `<div class="pd-empty"><b style="color:#cfd6e0">Накапливаем статистику.</b><br>` +
      `Движок работает в paper-режиме и оценивает каждый 5-минутный рынок BTC. ` +
      `Входит редко — только когда оценка вероятности заметно выше цены ордербука. ` +
      `Завершённые раунды и кривая PnL появятся здесь по мере накопления.</div>` +
      paperNote +
      `</div>`
    );
  }

  const pf = s.profitFactor === null ? '—' : s.profitFactor.toFixed(2);
  const updated = new Date(s.updatedAt).toLocaleString('ru-RU', { timeZone: 'UTC' });
  const netAccent = s.netPnl > 0 ? 'pos' : s.netPnl < 0 ? 'neg' : 'muted';

  return (
    styles +
    `<div class="pd-wrap">${header(s)}${intro}` +
    `<div class="pd-grid">` +
    statCard('Раундов', String(s.rounds)) +
    statCard('Win rate', `${s.winRate}%`) +
    statCard('Profit factor', pf) +
    statCard('Net PnL', fmtUsd(s.netPnl), netAccent) +
    statCard('Max drawdown', `$${s.maxDrawdown.toFixed(2)}`, 'muted') +
    statCard('Режим', s.mode === 'paper' ? 'Paper' : esc(s.mode), 'muted') +
    `</div>` +
    `<div class="pd-card"><h2>Кривая накопленного PnL</h2>${equitySvg(s.equityCurve)}` +
    `<div class="pd-foot">Выигрышей: ${s.wins} · Проигрышей: ${s.losses} · ` +
    `Исходы рынка ↑${s.marketOutcomes.up}/↓${s.marketOutcomes.down}</div></div>` +
    recentRoundsTable(s.recentRounds ?? []) +
    paperNote +
    `<p class="pd-foot">Обновлено: ${esc(updated)} UTC</p>` +
    `</div>`
  );
}

export async function predictRoute(app: FastifyInstance): Promise<void> {
  // Raw JSON for programmatic consumers / future client-side refresh.
  app.get('/predict/status.json', async (_req, reply) => {
    const s = readStatus();
    reply.header('Cache-Control', 'public, max-age=30');
    if (!s) {
      reply.code(503);
      return { ok: false, error: 'no_data_yet' };
    }
    return s;
  });

  app.get('/predict', async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=30');
    return pageShell('/predict — Robot Claude', renderBody(readStatus()), {
      lang: 'ru',
      autoRefreshSec: 60,
    });
  });
}
