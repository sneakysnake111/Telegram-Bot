require('dotenv').config()
const { Telegraf, Markup } = require('telegraf')
const { Client } = require('pg')
const cron = require('node-cron')

// ───────── CONFIG ─────────
const BOT_TOKEN = process.env.BOT_TOKEN
const DATABASE_URL = process.env.DATABASE_URL

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN')
if (!DATABASE_URL) throw new Error('Missing DATABASE_URL')

const bot = new Telegraf(BOT_TOKEN)

// ───────── DB ─────────
let db = null

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

// ───────── HELPERS ─────────
function todayDayName() {
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()]
}

function toDateStr(date = new Date()) {
  return date.toISOString().slice(0,10)
}

function formatDate(d) {
  return d.slice(8,10) + '.' + d.slice(5,7) + '.' + d.slice(0,4)
}

async function safeSend(chatId, text, opts = {}) {
  try {
    await bot.telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      ...opts
    })
  } catch (e) {
    console.error('[telegram]', e.message)
  }
}

// ───────── BOT START ─────────
bot.start(async (ctx) => {
  const u = ctx.from.username
  if (!u) return ctx.reply('Set Telegram username first')

  await ctx.reply('Welcome!', Markup.inlineKeyboard([
    Markup.button.callback('Subscribe', 'sub')
  ]))
})

// ───────── SUBSCRIBE ─────────
bot.action('sub', async (ctx) => {
  await ctx.answerCbQuery()

  const username = ctx.from.username?.toLowerCase()
  if (!username) return

  const chatId = ctx.chat.id

  const { rows } = await query(
    'SELECT student_name FROM parent_student_links WHERE telegram_username=$1',
    [username]
  )

  if (!rows.length)
    return ctx.reply('Not registered')

  await query(`
    INSERT INTO bot_registrations (telegram_username, chat_id)
    VALUES ($1,$2)
    ON CONFLICT (telegram_username)
    DO UPDATE SET chat_id=EXCLUDED.chat_id
  `, [username, chatId])

  await ctx.reply('Subscribed')
})

// ───────── CRON LOCK ─────────
let cronRunning = false

// ───────── CRON ─────────
cron.schedule('* * * * *', async () => {
  if (cronRunning) return
  cronRunning = true

  try {
    const now = new Date()
    const todayStr = toDateStr(now)
    const day = todayDayName()

    // ───────── CANCELLATIONS ─────────
    const canceled = await query(`
      SELECT cl.student_key, cl.student_name, cl.teacher_name,
             cl.canceled_date::text, br.chat_id
      FROM canceled_lessons cl
      JOIN parent_student_links psl ON psl.student_key=cl.student_key
      JOIN bot_registrations br ON br.telegram_username=psl.telegram_username
      WHERE cl.notification_sent=false
    `)

    for (const c of canceled.rows) {
      await safeSend(c.chat_id,
        `🚫 Lesson canceled\n${c.student_name} ${formatDate(c.canceled_date)}`
      )

      await query(
        'UPDATE canceled_lessons SET notification_sent=true WHERE student_key=$1 AND canceled_date=$2',
        [c.student_key, c.canceled_date]
      )

      await query(
        'INSERT INTO lesson_reminders_sent VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [c.student_key, c.canceled_date]
      )
    }

    // ───────── LESSONS ─────────
    const res = await query(`
      SELECT sss.student_key, sss.student_name, sss.teacher_name,
             sss.lesson_time, br.chat_id
      FROM student_schedule_slots sss
      JOIN parent_student_links psl ON psl.student_key=sss.student_key
      JOIN bot_registrations br ON br.telegram_username=psl.telegram_username
      WHERE sss.day_of_week=$1
    `, [day])

    for (const s of res.rows) {

      const [h,m] = s.lesson_time.split(':').map(Number)

      const lessonDate = new Date(now)
      lessonDate.setHours(h,m,0,0)

      const diffMin = (lessonDate - now) / 60000

      // 2.5h - 4h window (stable)
      if (diffMin < 150 || diffMin > 240) continue

      const already = await query(
        'SELECT 1 FROM lesson_reminders_sent WHERE student_key=$1 AND lesson_date=$2',
        [s.student_key, todayStr]
      )

      if (already.rows.length) continue

      await safeSend(s.chat_id,
        `⏰ Lesson reminder\n${s.student_name} at ${s.lesson_time}`
      )

      await query(
        'INSERT INTO lesson_reminders_sent (student_key, lesson_date) VALUES ($1,$2)',
        [s.student_key, todayStr]
      )
    }

  } catch (e) {
    console.error('[cron]', e)
  } finally {
    cronRunning = false
  }
})

// ───────── START BOT ─────────
getDb()
  .then(() => bot.launch())
  .then(() => console.log('Bot running'))
  .catch(e => console.error(e))

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))