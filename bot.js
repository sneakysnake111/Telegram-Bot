require('dotenv').config()

const { Telegraf, Markup } = require('telegraf')
const { Client } = require('pg')
const cron = require('node-cron')
const express = require('express')

// ───────────────── CONFIG ─────────────────

const BOT_TOKEN = process.env.BOT_TOKEN
const DATABASE_URL = process.env.DATABASE_URL

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN')
if (!DATABASE_URL) throw new Error('Missing DATABASE_URL')

const bot = new Telegraf(BOT_TOKEN)
const app = express()

// ───────────────── STATE ─────────────────

let db = null
let cronRunning = false
let lastCronRun = 0

const queryCache = new Map()
const sentLog = new Set()

// ───────────────── DB ─────────────────

async function getDb() {
  if (db) return db

  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  })

  await client.connect()

  client.on('error', (err) => {
    console.error('[db error]', err.message)
    db = null
    client.end().catch(() => {})
  })

  db = client
  return db
}

async function query(text, values = []) {
  const client = await getDb()
  return client.query(text, values)
}

async function querySafe(text, values = [], retries = 2) {
  try {
    return await query(text, values)
  } catch (err) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 500))
      return querySafe(text, values, retries - 1)
    }
    throw err
  }
}

// ───────────────── CACHE ─────────────────

async function cachedQuery(key, fn, ttl = 5000) {
  const now = Date.now()
  const cached = queryCache.get(key)

  if (cached && now - cached.time < ttl) {
    return cached.data
  }

  const data = await fn()
  queryCache.set(key, { data, time: now })
  return data
}

// ───────────────── HELPERS ─────────────────

function todayDayName() {
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()]
}

function toDateStr(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

function formatDate(d) {
  const [y,m,day] = String(d).slice(0,10).split('-')
  return `${day}.${m}.${y}`
}

async function safeSend(chatId, text) {
  try {
    return await bot.telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML'
    })
  } catch (err) {
    console.error('[telegram error]', err.message)
  }
}

// ───────────────── BOT ─────────────────

bot.start(async (ctx) => {
  const username = ctx.from.username

  if (!username) return ctx.reply('❌ Set username')

  await ctx.reply(
    '👋 Welcome',
    Markup.inlineKeyboard([
      Markup.button.callback('✅ Subscribe', 'subscribe')
    ])
  )
})

bot.action('subscribe', async (ctx) => {
  await ctx.answerCbQuery()

  const username = ctx.from.username?.toLowerCase()
  const chatId = ctx.chat.id

  if (!username) return

  const links = await querySafe(
    'SELECT student_name FROM parent_student_links WHERE telegram_username=$1',
    [username]
  )

  if (links.rows.length === 0) {
    return ctx.reply('❌ Not registered')
  }

  await querySafe(
    `INSERT INTO bot_registrations (telegram_username, chat_id)
     VALUES ($1,$2)
     ON CONFLICT (telegram_username)
     DO UPDATE SET chat_id=$2`,
    [username, chatId]
  )

  await ctx.reply('✅ Subscribed')
})

// ───────────────── CRON ─────────────────

cron.schedule('* * * * *', async () => {
  const nowTs = Date.now()

  if (cronRunning || nowTs - lastCronRun < 50000) return

  cronRunning = true
  lastCronRun = nowTs

  try {
   const now = new Date()

const today = toDateStr(now)
const day = todayDayName()

const tolerance = 5 // хвилин

function parseDateTime(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00`)
}

    sentLog.clear()

    // ───── CANCELLATIONS ─────
    const canceled = await querySafe(`
      SELECT cl.student_key, cl.student_name, cl.teacher_name,
             cl.canceled_date::text, br.chat_id
      FROM canceled_lessons cl
      JOIN parent_student_links psl ON psl.student_key=cl.student_key
      JOIN bot_registrations br ON br.telegram_username=psl.telegram_username
      WHERE cl.notification_sent=false
    `)

    for (const row of canceled.rows) {

      const key = `cancel_${row.student_key}_${row.canceled_date}`
      if (sentLog.has(key)) continue
      sentLog.add(key)

      await safeSend(
        row.chat_id,
        `🚫 <b>Lesson canceled</b>\n${row.student_name}\n${formatDate(row.canceled_date)}`
      )

      await querySafe(
        `UPDATE canceled_lessons
         SET notification_sent=true
         WHERE student_key=$1 AND canceled_date=$2`,
        [row.student_key, row.canceled_date]
      )

      await querySafe(
        `INSERT INTO lesson_reminders_sent VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [row.student_key, row.canceled_date]
      )
    }

    // ───── REMINDERS ─────
    const slots = await cachedQuery(`slots_${day}`, () =>
      querySafe(`
        SELECT sss.student_key, sss.student_name, sss.teacher_name,
               sss.lesson_time, br.chat_id
        FROM student_schedule_slots sss
        JOIN parent_student_links psl ON psl.student_key=sss.student_key
        JOIN bot_registrations br ON br.telegram_username=psl.telegram_username
        WHERE sss.day_of_week=$1
      `, [day])
    )

    for (const slot of slots.rows) {

      const lessonDateTime = parseDateTime(today, slot.lesson_time)

const diffMin = (lessonDateTime - now) / 60000

if (diffMin < 175 || diffMin > 185) continue

      const key = `rem_${slot.student_key}_${today}`
      if (sentLog.has(key)) continue

      const blocked = await querySafe(
        `SELECT 1 FROM lesson_reminders_sent
         WHERE student_key=$1 AND lesson_date=$2`,
        [slot.student_key, today]
      )

      if (blocked.rows.length > 0) continue

      sentLog.add(key)

      await safeSend(
        slot.chat_id,
        `⏰ <b>Reminder</b>\n${slot.student_name} at ${slot.lesson_time}`
      )

      await querySafe(
        `INSERT INTO lesson_reminders_sent VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [slot.student_key, today]
      )
    }

  } catch (err) {
    console.error('[cron error]', err)
  } finally {
    cronRunning = false
  }
})

// ───────────────── EXPRESS ─────────────────

app.get('/', (req,res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    cronRunning,
    lastCronRun
  })
})

app.listen(process.env.PORT || 10000)

// ───────────────── START ─────────────────

getDb()
  .then(() => bot.launch())
  .then(() => console.log('Bot running'))
  .catch(err => {
    console.error(err)
    process.exit(1)
  })

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))