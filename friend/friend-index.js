// gymlog-relay-friend — Cloudflare Worker
// This is a standalone copy for a SECOND person's independent gym log.
// It does not share any data with the original gymlog-relay Worker — separate
// KV namespace, separate Telegram bot, separate secrets. Follow the setup
// checklist that came with this file to fill in the placeholders below.
//
// Holds Telegram bot token + chat ID as secrets (never exposed to the browser),
// relays workout/calendar messages to Telegram, stores workout history in KV
// so it syncs automatically across every device that opens the app, and runs
// a scheduled (cron) job that sends check-ins / evening nudges / a cycle
// recap — but ONLY on days explicitly tagged as a planned training day in
// the app (via the /plan endpoint). No more guessing rest days.
//
// PROGRESS MODEL: not a calendar week. A "cycle" is a rolling 7-day window
// that starts the moment you log your first workout after the previous cycle
// closed. You need CYCLE_TARGET sessions within those 7 days. When a cycle
// closes, nothing carries over — your next workout just opens a fresh cycle,
// no debt either way. The streak only continues if the next successful cycle
// starts the very next day after the previous one closed — any gap (skipping
// weeks then cramming) breaks the chain, so it can't be gamed that way.
//
// SETUP — replace these before deploying:
//   1. ALLOWED_ORIGIN below — set to wherever you end up hosting the friend's
//      copy of gymlog.html (e.g. a Cloudflare Pages URL or Workers static URL).
//   2. Deploy this Worker under its OWN name (e.g. "gymlog-relay-friend"),
//      not by overwriting the original.
//
// Required secrets (Settings → Variables and Secrets, type = Secret) — use a
// NEW Telegram bot (via @BotFather) and that bot's own chat ID, not the
// original bot:
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
//   APP_SHARED_SECRET   (any random string — the app must send this back as proof it's really the app)
//
// Required binding (Settings → Bindings) — create a NEW KV namespace for this,
// do not reuse the original gymlog_data namespace:
//   GYMLOG_KV  →  (new KV namespace, e.g. gymlog_data_friend)
//
// Required cron triggers (Settings → Triggers → Cron Triggers) — add all five,
// using the "Cron expression" tab:
//   0 6  * * *   (9am local — morning check-in, currently EEST/UTC+3)
//   0 15 * * *   (6pm local — evening nudge, gentle)
//   0 16 * * *   (7pm local — evening nudge, firmer)
//   0 17 * * *   (8pm local — evening nudge, final)
//   0 20 * * *   (11pm local, EVERY DAY — cycle recap only sends on days a
//                 cycle actually closes; silent otherwise)
//   NOTE: after Moldova's DST ends (~late Oct 2026, EEST→EET/UTC+2), every
//   trigger's hour shifts one later: 6→7, 15→16, 16→17, 17→18, 20→21 (all * * *).
//   Adjust all of the above if your friend is in a different timezone.

const ALLOWED_ORIGIN = 'https://gymlog.mrweezy.workers.dev'; // e.g. https://gymlog-friend.pages.dev
const CYCLE_TARGET = 3;      // sessions needed within each 7-day cycle — must match CYCLE_TARGET in the app
const CYCLE_LEN_DAYS = 7;    // length of one rolling cycle

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Secret',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function buildCalendarText(gymDays, logDate) {
  const year = logDate.getFullYear();
  const month = logDate.getMonth();
  const now = new Date();
  const today = now.getDate();
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();
  const monthName = logDate.toLocaleString('en-US', { month: 'long' });
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const emoji = d => {
    if (gymDays.has(d)) return `${String(d).padStart(2, '0')}✅`;
    if (!isCurrentMonth || d < today) return `${String(d).padStart(2, '0')}🔴`;
    return `${String(d).padStart(2, '0')}⬜`;
  };

  let msg = `📅 *${monthName} ${year}*\n\n`;
  const dayNums = [];
  for (let d = 1; d <= daysInMonth; d++) dayNums.push(d);
  for (let i = 0; i < dayNums.length; i += 5) {
    msg += dayNums.slice(i, i + 5).map(emoji).join(' ') + '\n';
  }
  return msg.trimEnd();
}

async function sendTelegramMessage(env, text, parseMode = 'MarkdownV2') {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: parseMode }),
  });
  return res.json();
}

// Escapes MarkdownV2 special characters so plain reminder text renders safely.
function escapeMd(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// Escapes HTML special characters for messages sent with parse_mode 'HTML'
// (used by the weekly recap, which needs real <b> formatting that MarkdownV2's
// escape-everything approach makes painful to hand-author).
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isoDateStr(d) { return d.toISOString().slice(0, 10); }

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return isoDateStr(d);
}

// Groups a sorted list of workout dates into consecutive 7-day cycles: each
// cycle starts on the earliest not-yet-consumed workout date and runs
// CYCLE_LEN_DAYS days, consuming every workout date that falls in that
// window. Nothing forces cycles to be adjacent — a gap between one cycle's
// end and the next cycle's start is exactly what breaks a streak, below.
function buildCycles(history, override) {
  const dates = [...new Set(history.filter(e => !e.excludeFromCycle).map(e => e.date))].sort();
  const cycles = [];
  let i = 0;
  while (i < dates.length) {
    const start = dates[i];
    const end = addDays(start, CYCLE_LEN_DAYS - 1);
    let count = 0;
    while (i < dates.length && dates[i] <= end) { count++; i++; }
    cycles.push({ start, end, count, success: count >= CYCLE_TARGET });
  }
  // Manual correction, if set: only applies while no workout has been logged
  // past the corrected cycle's end — self-expires the moment a real new
  // cycle naturally begins, so it can't leak onto a cycle it wasn't meant for.
  if (override && cycles.length) {
    const lastDate = dates[dates.length - 1];
    if (lastDate <= override.end) {
      const newEnd = addDays(override.start, CYCLE_LEN_DAYS - 1);
      const newCount = dates.filter(d => d >= override.start && d <= newEnd).length;
      cycles[cycles.length - 1] = { start: override.start, end: newEnd, count: newCount, success: newCount >= CYCLE_TARGET };
    }
  }
  return cycles;
}

// The cycle currently in progress as of todayStr — null if there isn't one
// (either you've never trained, or your last cycle closed and you haven't
// logged a workout since to open a new one).
function getCurrentCycle(history, todayStr, override) {
  const cycles = buildCycles(history, override);
  if (!cycles.length) return null;
  const last = cycles[cycles.length - 1];
  if (last.end < todayStr) return null; // closed, nothing new started yet
  const daysLeft = Math.round((new Date(last.end + 'T00:00:00Z') - new Date(todayStr + 'T00:00:00Z')) / 86400000) + 1;
  return { start: last.start, end: last.end, count: last.count, daysLeft };
}

// Consecutive successful cycles chained with zero gap between them, counting
// up to (but not including) any cycle that hasn't closed yet as of todayStr.
// A gap before a cycle — even a successful one — starts a fresh streak of 1
// instead of continuing the old one; this is what stops "skip two weeks then
// cram one" from counting as a multi-cycle streak.
function computeStreak(history, todayStr, override) {
  const cycles = buildCycles(history, override);
  let streak = 0;
  let chainActive = false;
  let prevEnd = null;
  for (const c of cycles) {
    if (c.end >= todayStr) break; // not closed yet — don't judge it
    if (c.success) {
      streak = (chainActive && c.start === addDays(prevEnd, 1)) ? streak + 1 : 1;
      chainActive = true;
    } else {
      streak = 0;
      chainActive = false;
    }
    prevEnd = c.end;
  }
  return streak;
}


async function loadState(env) {
  const [historyRaw, planRaw, overrideRaw] = await Promise.all([
    env.GYMLOG_KV.get('history'),
    env.GYMLOG_KV.get('plan'),
    env.GYMLOG_KV.get('cycle-override'),
  ]);
  return {
    history: historyRaw ? JSON.parse(historyRaw) : [],
    plan: planRaw ? JSON.parse(planRaw) : [], // array of 'YYYY-MM-DD' — days the app user has tagged as an intended training day
    override: overrideRaw ? JSON.parse(overrideRaw) : null, // { start, end } manual correction for the current cycle's start date
  };
}

// 9am local — heads-up on where the week stands, so there's time to plan the day
// around it instead of only finding out you're behind at 8pm.
// Only fires on days YOU tagged as a planned training day in the app — no more
// guessing which days are rest days. If no plan is set for the current week at
// all, sends a one-line nudge to go set one instead of a normal check-in.
// Uses a "next 7 days from today" rolling window for the plan-check, entirely
// separate from the streak cycle — planning is just a convenience for gating
// reminders, the streak/cycle math only ever looks at actual workout dates.
async function morningCheckIn(env) {
  const now = new Date();
  const todayStr = isoDateStr(now);
  const { history, plan, override } = await loadState(env);

  const upcoming = plan.filter(d => d >= todayStr && d <= addDays(todayStr, 6));
  if (upcoming.length === 0) {
    await sendTelegramMessage(env, escapeMd(`📋 No training days planned for the next 7 days. Open the app and tag which days you're training — reminders only fire on those.`));
    return;
  }

  if (!plan.includes(todayStr)) return; // today isn't a planned training day — stay quiet
  if (history.some(e => e.date === todayStr)) return; // already trained today

  const cycle = getCurrentCycle(history, todayStr, override);
  if (cycle && cycle.count >= CYCLE_TARGET) return; // this cycle's quota already met

  const streak = computeStreak(history, todayStr, override);
  let text = cycle
    ? `☀️ Gym check-in: today's a planned training day. ${cycle.count}/${CYCLE_TARGET} done this cycle, ${cycle.daysLeft} day(s) left in this 7-day window.`
    : `☀️ Gym check-in: today's a planned training day — logging it kicks off a fresh 7-day cycle.`;
  if (streak > 0) text += `\nCurrent streak: ${streak} cycle(s) — keep it going.`;
  await sendTelegramMessage(env, escapeMd(text));
}

// Runs every night at 11pm, but only actually sends a message on a day a
// cycle's 7-day window closes — silent every other night. This is why the
// old Sunday-only trigger needs switching to run daily: cycles can close on
// any day of the week depending on when you started them.
async function cycleRecap(env) {
  const now = new Date();
  const todayStr = isoDateStr(now);
  const { history, override } = await loadState(env);
  const cycles = buildCycles(history, override);
  const closingToday = cycles.find(c => c.end === todayStr);
  if (!closingToday) return; // no cycle closes today — stay quiet

  const met = closingToday.success;
  const streak = computeStreak(history, addDays(todayStr, 1), override); // tomorrow, so today's closing cycle counts as judged

  const filled = Math.min(closingToday.count, CYCLE_TARGET);
  const bar = '🟩'.repeat(filled) + '⬜'.repeat(Math.max(0, CYCLE_TARGET - filled))
    + (closingToday.count > CYCLE_TARGET ? ' ' + '⭐'.repeat(closingToday.count - CYCLE_TARGET) : '');

  const cycleEntries = history.filter(e => e.date >= closingToday.start && e.date <= closingToday.end);

  let text = `<b>📊 CYCLE WRAP</b>\n`;
  text += `━━━━━━━━━━━━\n`;
  text += `${escapeHtml(closingToday.start)} → ${escapeHtml(closingToday.end)}\n`;
  text += `Sessions: <b>${closingToday.count}/${CYCLE_TARGET}</b>  ${bar}\n\n`;

  if (cycleEntries.length) {
    text += `🏋️ <b>Trained</b>\n`;
    text += cycleEntries
      .slice().sort((a, b) => a.date.localeCompare(b.date))
      .map(e => `• <b>${escapeHtml(e.name || 'workout')}</b> — ${escapeHtml(e.date)}`)
      .join('\n');
    text += `\n\n`;
  } else {
    text += `🏋️ No sessions logged this cycle\n\n`;
  }

  text += met
    ? `✅ <b>Streak: ${streak} cycle(s)</b> and counting`
    : `❌ Streak broken — back to 0. Your next workout starts a fresh cycle.`;

  await sendTelegramMessage(env, text, 'HTML');
}

// Called by the 3 daily evening cron triggers. level is 'gentle'|'firm'|'final'.
// Only fires on days tagged as a planned training day in the app. Also silent
// if you already trained today or already hit this cycle's quota.
async function handleCron(env, level) {
  const now = new Date();
  const todayStr = isoDateStr(now);
  const { history, plan, override } = await loadState(env);

  if (!plan.includes(todayStr)) return; // not a planned training day — stay quiet
  if (history.some(e => e.date === todayStr)) return; // already trained today

  const cycle = getCurrentCycle(history, todayStr, override);
  if (cycle && cycle.count >= CYCLE_TARGET) return; // this cycle's quota already met

  const remaining = CYCLE_TARGET - (cycle ? cycle.count : 0);
  const streak = computeStreak(history, todayStr, override);
  const cycleNote = cycle ? `${cycle.daysLeft} day(s) left in this cycle` : `today opens a new cycle`;

  let text;
  if (level === 'gentle') {
    text = `🔔 No workout logged today.\n${remaining} more needed — ${cycleNote}.`;
  } else if (level === 'firm') {
    text = `⚠️ Still nothing logged today.\nYou need ${remaining} more and time's ticking — ${cycleNote}.`;
  } else {
    text = `🚨 Last call today.\nStill ${remaining} short${cycle ? ` for this cycle` : ''}.`;
  }
  if (streak > 0) text += `\nCurrent streak: ${streak} cycle(s).`;

  await sendTelegramMessage(env, escapeMd(text));
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const auth = request.headers.get('X-App-Secret');
    if (auth !== env.APP_SHARED_SECRET) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }

    try {
      // --- Send a workout message to Telegram ---
      if (url.pathname === '/telegram/send' && request.method === 'POST') {
        const { text } = await request.json();
        if (!text) return json({ ok: false, error: 'missing text' }, 400);
        const result = await sendTelegramMessage(env, text);
        return json(result.ok ? { ok: true } : { ok: false, error: result.description || 'telegram error' });
      }

      // --- Send/update the monthly calendar graphic ---
      if (url.pathname === '/telegram/calendar' && request.method === 'POST') {
        const { logDate: logDateStr } = await request.json();
        if (!logDateStr) return json({ ok: false, error: 'missing logDate' }, 400);
        const logDate = new Date(logDateStr + 'T12:00:00');
        const logDay = logDate.getDate();
        const key = `cal_days_${logDate.getFullYear()}_${logDate.getMonth()}`;

        let gymDays = new Set();
        const stored = await env.GYMLOG_KV.get(key);
        if (stored) {
          try { gymDays = new Set(JSON.parse(stored)); } catch {}
        }
        gymDays.add(logDay);
        await env.GYMLOG_KV.put(key, JSON.stringify([...gymDays]));

        const calText = buildCalendarText(gymDays, logDate);
        const result = await sendTelegramMessage(env, calText);
        return json(result.ok ? { ok: true } : { ok: false, error: result.description || 'telegram error' });
      }

      // --- Rebuild a month's calendar from a full list of workout days (e.g. from local History) ---
      if (url.pathname === '/telegram/calendar/rebuild' && request.method === 'POST') {
        const { year, month, days } = await request.json();
        if (year == null || month == null || !Array.isArray(days)) {
          return json({ ok: false, error: 'missing year, month, or days' }, 400);
        }
        const key = `cal_days_${year}_${month}`;
        const gymDays = new Set(days);
        await env.GYMLOG_KV.put(key, JSON.stringify([...gymDays]));

        const logDate = new Date(year, month, 1, 12);
        const calText = buildCalendarText(gymDays, logDate);
        const result = await sendTelegramMessage(env, calText);
        return json(result.ok ? { ok: true, count: gymDays.size } : { ok: false, error: result.description || 'telegram error' });
      }

      // --- Read full workout history ---
      if (url.pathname === '/history' && request.method === 'GET') {
        const stored = await env.GYMLOG_KV.get('history');
        return json({ ok: true, history: stored ? JSON.parse(stored) : [] });
      }

      // --- Overwrite full workout history (client sends the merged array) ---
      if (url.pathname === '/history' && request.method === 'PUT') {
        const body = await request.json();
        if (!Array.isArray(body)) return json({ ok: false, error: 'expected an array' }, 400);
        await env.GYMLOG_KV.put('history', JSON.stringify(body));
        return json({ ok: true, count: body.length });
      }

      // --- Read planned training days (dates the app user has tagged as intended workout days) ---
      if (url.pathname === '/plan' && request.method === 'GET') {
        const stored = await env.GYMLOG_KV.get('plan');
        return json({ ok: true, plan: stored ? JSON.parse(stored) : [] });
      }

      // --- Overwrite planned training days (client sends the merged array) ---
      if (url.pathname === '/plan' && request.method === 'PUT') {
        const body = await request.json();
        if (!Array.isArray(body)) return json({ ok: false, error: 'expected an array' }, 400);
        await env.GYMLOG_KV.put('plan', JSON.stringify(body));
        return json({ ok: true, count: body.length });
      }

      // --- Read the manual correction for the current cycle's start date ---
      if (url.pathname === '/cycle-override' && request.method === 'GET') {
        const stored = await env.GYMLOG_KV.get('cycle-override');
        return json({ ok: true, override: stored ? JSON.parse(stored) : null });
      }

      // --- Set/clear the manual correction (client sends { start, end } or null) ---
      if (url.pathname === '/cycle-override' && request.method === 'PUT') {
        const body = await request.json();
        if (body !== null && (typeof body !== 'object' || !body.start || !body.end)) {
          return json({ ok: false, error: 'expected { start, end } or null' }, 400);
        }
        if (body === null) await env.GYMLOG_KV.delete('cycle-override');
        else await env.GYMLOG_KV.put('cycle-override', JSON.stringify(body));
        return json({ ok: true });
      }

      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // Dispatch by actual UTC hour/day at runtime rather than matching the raw
    // cron string — Cloudflare's dashboard has been inconsistent about how it
    // stores/reports the day-of-week field. Dispatching by UTC hour alone
    // sidesteps that entirely, and it's also just correct now that recap
    // timing depends on when a cycle closes rather than the calendar day.
    const now = new Date();
    const hourUTC = now.getUTCHours();

    if (hourUTC === 6) {
      ctx.waitUntil(morningCheckIn(env));
    } else if (hourUTC === 20) {
      ctx.waitUntil(cycleRecap(env)); // no-ops internally unless a cycle closes today
    } else if (hourUTC === 15) {
      ctx.waitUntil(handleCron(env, 'gentle'));
    } else if (hourUTC === 16) {
      ctx.waitUntil(handleCron(env, 'firm'));
    } else if (hourUTC === 17) {
      ctx.waitUntil(handleCron(env, 'final'));
    }
  },
};
