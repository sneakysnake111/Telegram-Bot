/**
 * Telegram Lesson Reminder Bot
 * ─────────────────────────────
 * Stack: Node.js 18+, Telegraf, pg, node-cron
 *
 * Install:
 *   npm install telegraf pg node-cron dotenv
 *
 * .env:
 *   BOT_TOKEN=твій_новий_токен_від_BotFather
*    DATABASE_URL=postgresql://user:password@host:5432/db
 *
 /**
 * Run:  node bot.js
 */

require('dotenv').config()
const { Telegraf, Markup } = require('telegraf')
const { Client } = require('pg')
const cron = require('node-cron')
const express = require('express')
// ── Config ────────────────────────────────────────────────────────────────────

const BOT_TOKEN    = process.env.BOT_TOKEN
const DATABASE_URL = process.env.DATABASE_URL

if (!BOT_TOKEN)    throw new Error('Missing BOT_TOKEN in .env')
if (!DATABASE_URL) throw new Error('Missing DATABASE_URL in .env')

const bot = new Telegraf(BOT_TOKEN)

// ── DB: single Client with auto-reconnect ────────────────────────────────────

let db = null

async function getDb() {
  if (db) return db
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  await client.connect()
  client.on('error', (err) => {
    console.error('[db] connection error, will reconnect:', err.message)
    db = null
    client.end().catch(() => {})
  })
  db = client
  console.log('[db] connected to Supabase')
  return db
}

async function query(text, values = []) {
  try {
    const client = await getDb()
    return await client.query({ text, values })
  } catch (err) {
    if (err.code === 'ECONNRESET' || err.code === '57P01' || err.code === '08006') {
      console.warn('[db] reconnecting…')
      db = null
      const client = await getDb()
      return client.query({ text, values })
    }
    throw err
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayDayName() {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()]
}

function toDateStr(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

function formatDate(isoDate) {
  const [y, m, d] = String(isoDate).slice(0, 10).split('-')
  return `${d}.${m}.${y}`
}

// ── /start → show Subscribe button ───────────────────────────────────────────

bot.start(async (ctx) => {
  const rawUsername = ctx.from.username

  if (!rawUsername) {
    return ctx.replyWithHTML(
      '❌ <b>No Telegram username set.</b>\n\n' +
      'Please set one in <i>Settings → Username</i>, then send /start again.'
    )
  }

  await ctx.replyWithHTML(
    '👋 <b>Welcome to the Lesson Bot!</b>\n\n' +
    'Press <b>Subscribe</b> below to start receiving lesson reminders and cancellation alerts.',
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Subscribe', 'do_subscribe')]
    ])
  )
})

// ── Button: Subscribe ─────────────────────────────────────────────────────────

bot.action('do_subscribe', async (ctx) => {
  await ctx.answerCbQuery()

  const rawUsername = ctx.from.username
  const chatId = ctx.chat.id

  if (!rawUsername) {
    return ctx.replyWithHTML('❌ No Telegram username found. Please set one and try /start again.')
  }

  const username = rawUsername.toLowerCase()
  console.log(`[subscribe] username=${username} chatId=${chatId}`)

  let links
  try {
    const result = await query(
      'SELECT student_name, teacher_name FROM parent_student_links WHERE telegram_username = $1',
      [username]
    )
    links = result.rows
  } catch (err) {
    console.error('[subscribe] DB error:', err.message)
    return ctx.replyWithHTML('⚠️ Database error. Please try again.')
  }

  if (links.length === 0) {
    return ctx.replyWithHTML(
      `❌ <b>@${username}</b> is not registered in the system.\n\n` +
      `Ask the administrator to:\n` +
      `1. Add your @username in the <b>Parents</b> page\n` +
      `2. Click <b>Sync to Bot DB</b> on the Bot page\n\n` +
      `Then press Subscribe again.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Try again', 'do_subscribe')]
      ])
    )
  }

  try {
    await query(
      `INSERT INTO bot_registrations (telegram_username, chat_id)
       VALUES ($1, $2)
       ON CONFLICT (telegram_username) DO UPDATE
         SET chat_id = EXCLUDED.chat_id, registered_at = NOW()`,
      [username, chatId]
    )
  } catch (err) {
    console.error('[subscribe] registration error:', err.message)
    return ctx.replyWithHTML('⚠️ Could not complete registration. Please try again.')
  }

  const studentList = links
    .map(r => `• <b>${r.student_name}</b> — ${r.teacher_name}`)
    .join('\n')

  await ctx.replyWithHTML(
    `✅ <b>Subscribed!</b>\n\nYou will receive reminders for:\n${studentList}\n\n` +
    `📬 Reminders arrive <b>3 hours before</b> each lesson.\n` +
    `🚫 Cancellations are sent immediately.`,
    Markup.inlineKeyboard([
      [Markup.button.callback('📅 My schedule',      'show_schedule')],
      [Markup.button.callback('🚫 Canceled lessons', 'show_canceled')],
    ])
  )
})

// ── Button: show schedule ─────────────────────────────────────────────────────

bot.action('show_schedule', async (ctx) => {
  await ctx.answerCbQuery()
  const username = ctx.from.username?.toLowerCase()
  if (!username) return

  const { rows } = await query(
    `SELECT psl.student_name, psl.teacher_name, sss.day_of_week, sss.lesson_time
     FROM parent_student_links psl
     LEFT JOIN student_schedule_slots sss ON sss.student_key = psl.student_key
     WHERE psl.telegram_username = $1
     ORDER BY psl.student_name, sss.day_of_week`,
    [username]
  )

  if (rows.length === 0) {
    return ctx.replyWithHTML(
      '📅 No schedule set yet.',
      Markup.inlineKeyboard([[Markup.button.callback('« Menu', 'back_to_menu')]])
    )
  }

  const byStudent = {}
  for (const row of rows) {
    if (!byStudent[row.student_name]) {
      byStudent[row.student_name] = { teacher: row.teacher_name, slots: [] }
    }
    if (row.day_of_week) {
      const time = row.lesson_time ? ` <b>${row.lesson_time}</b>` : ''
      byStudent[row.student_name].slots.push(`${row.day_of_week}${time}`)
    }
  }

  const lines = Object.entries(byStudent).map(([name, data]) => {
    const days = data.slots.length ? data.slots.join(' · ') : 'No days set'
    return `👤 <b>${name}</b> (${data.teacher})\n   📆 ${days}`
  })

  await ctx.replyWithHTML(
    `📅 <b>Schedule</b>\n\n${lines.join('\n\n')}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🚫 Canceled lessons', 'show_canceled')],
      [Markup.button.callback('« Menu',             'back_to_menu')],
    ])
  )
})

// ── Button: show canceled ─────────────────────────────────────────────────────

bot.action('show_canceled', async (ctx) => {
  await ctx.answerCbQuery()
  const username = ctx.from.username?.toLowerCase()
  if (!username) return

  const today = toDateStr()
  const { rows } = await query(
    `SELECT cl.student_name, cl.teacher_name, cl.canceled_date
     FROM canceled_lessons cl
     INNER JOIN parent_student_links psl ON psl.student_key = cl.student_key
     WHERE psl.telegram_username = $1 AND cl.canceled_date >= $2
     ORDER BY cl.canceled_date`,
    [username, today]
  )

  if (rows.length === 0) {
    return ctx.replyWithHTML(
      '✅ No upcoming canceled lessons.',
      Markup.inlineKeyboard([[Markup.button.callback('« Menu', 'back_to_menu')]])
    )
  }

  const lines = rows.map(r =>
    `🚫 <b>${r.student_name}</b>\n   📅 ${formatDate(r.canceled_date)} — ${r.teacher_name}`
  )

  await ctx.replyWithHTML(
    `🚫 <b>Canceled lessons</b>\n\n${lines.join('\n\n')}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('📅 Schedule', 'show_schedule')],
      [Markup.button.callback('« Menu',      'back_to_menu')],
    ])
  )
})

// ── Button: back to menu ──────────────────────────────────────────────────────

bot.action('back_to_menu', async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.replyWithHTML(
    '📚 <b>Main menu</b>',
    Markup.inlineKeyboard([
      [Markup.button.callback('📅 My schedule',      'show_schedule')],
      [Markup.button.callback('🚫 Canceled lessons', 'show_canceled')],
    ])
  )
})

// ── Cron: every minute ────────────────────────────────────────────────────────
// One combined cron handles both reminders and cancellations.
// Only ONE notification per lesson per day is sent:
//   • If lesson is canceled today → cancellation only (reminder suppressed)
//   • If lesson is not canceled   → reminder 3 h before (once per day)

cron.schedule('* * * * *', async () => {
  const now      = new Date()
  const todayStr = toDateStr(now)
  const day      = todayDayName()
  const nowMins  = now.getHours() * 60 + now.getMinutes()
  const winStart = nowMins + 150  // 2h30m from now
  const winEnd   = nowMins + 180  // 3h00m from now

  // ── A. Cancellation notifications (highest priority) ─────────────────────
  try {
    const { rows: canceled } = await query(
      `SELECT cl.student_key, cl.student_name, cl.teacher_name,
              cl.canceled_date::text AS canceled_date,
              br.chat_id
       FROM canceled_lessons cl
       INNER JOIN parent_student_links psl ON psl.student_key = cl.student_key
       INNER JOIN bot_registrations br ON br.telegram_username = psl.telegram_username
       WHERE cl.notification_sent = FALSE`
    )

    for (const row of canceled) {
      try {
        await bot.telegram.sendMessage(
          row.chat_id,
          `🚫 <b>Lesson canceled</b>\n\n` +
          `The lesson for <b>${row.student_name}</b> on <b>${formatDate(row.canceled_date)}</b> is canceled.\n` +
          `👩‍🏫 Teacher: ${row.teacher_name}`,
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('🚫 All cancellations', 'show_canceled')],
              [Markup.button.callback('📅 My schedule',       'show_schedule')],
            ]).reply_markup,
          }
        )
        console.log(`[cron] cancellation sent: ${row.student_name} ${row.canceled_date}`)
      } catch (err) {
        console.error(`[cron] cancellation send failed:`, err.message)
        continue
      }

      // Mark cancellation notified
      await query(
        'UPDATE canceled_lessons SET notification_sent = TRUE WHERE student_key = $1 AND canceled_date = $2',
        [row.student_key, row.canceled_date]
      )

      // Also suppress any reminder for this lesson today — one notification only
      await query(
        'INSERT INTO lesson_reminders_sent (student_key, lesson_date) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [row.student_key, row.canceled_date]
      )
    }
  } catch (err) {
    console.error('[cron] cancellation error:', err.message)
  }

  // ── B. Lesson reminders (only if not already notified) ────────────────────
  try {
    const { rows: slots } = await query(
      `SELECT sss.student_key, sss.student_name, sss.teacher_name, sss.lesson_time,
              br.chat_id
       FROM student_schedule_slots sss
       INNER JOIN parent_student_links psl ON psl.student_key = sss.student_key
       INNER JOIN bot_registrations br ON br.telegram_username = psl.telegram_username
       WHERE sss.day_of_week = $1 AND sss.lesson_time != ''`,
      [day]
    )

    for (const slot of slots) {
      const [h, m] = slot.lesson_time.split(':').map(Number)
      if (isNaN(h) || isNaN(m)) continue
      const lessonMins = h * 60 + m
      if (lessonMins < winStart || lessonMins > winEnd) continue

      // Skip if already notified today (reminder or cancellation)
      const { rows: alreadySent } = await query(
        'SELECT 1 FROM lesson_reminders_sent WHERE student_key = $1 AND lesson_date = $2',
        [slot.student_key, todayStr]
      )
      if (alreadySent.length > 0) continue

      try {
        await bot.telegram.sendMessage(
          slot.chat_id,
          `⏰ <b>Lesson reminder</b>\n\n` +
          `📚 <b>${slot.student_name}</b> has a lesson today at <b>${slot.lesson_time}</b>\n` +
          `👩‍🏫 Teacher: ${slot.teacher_name}\n\nSee you in 3 hours! 🎵`,
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('📅 Full schedule', 'show_schedule')]
            ]).reply_markup,
          }
        )
        console.log(`[cron] reminder sent: ${slot.student_name} ${slot.lesson_time}`)
      } catch (err) {
        console.error(`[cron] reminder send failed:`, err.message)
        continue
      }

      await query(
        'INSERT INTO lesson_reminders_sent (student_key, lesson_date) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [slot.student_key, todayStr]
      )
    }
  } catch (err) {
    console.error('[cron] reminder error:', err.message)
  }
})

// ── Launch ────────────────────────────────────────────────────────────────────
const app = express()

app.get('/', (req, res) => {
  res.send('Bot is running')
})

const PORT = process.env.PORT || 10000

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`)
})

getDb()
  .then(() => bot.launch())
  .then(() => console.log('🤖 Bot is running'))
  .catch((err) => { console.error('Failed to start:', err.message); process.exit(1) })

process.once('SIGINT',  () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
