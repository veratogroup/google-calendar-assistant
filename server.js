// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis');
const {
  startOfWeek,
  addDays,
  startOfDay,
  endOfDay,
  parseISO,
  isValid,
  setHours,
  setMinutes,
  setSeconds,
  isBefore,
  addMinutes,
  isSameDay
} = require('date-fns');
const { zonedTimeToUtc, utcToZonedTime, format } = require('date-fns-tz');

const app = express();
app.use(bodyParser.json());

// ---------- Security hardening ----------
app.use(helmet());
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

// ---------- Config / Rules ----------
const TZ_DEFAULT = process.env.DEFAULT_TZ || 'America/Chicago';
const CAL_ID = process.env.CALENDAR_ID || 'primary';

// Scheduling rules (edit via env if desired)
const RULES = {
  WORK_DAYS: (process.env.WORK_DAYS || '1,2,3,4,5').split(',').map(n => parseInt(n.trim(),10)), // 0=Sun..6=Sat
  WORK_START_HOUR: parseInt(process.env.WORK_START_HOUR || '9', 10),    // 9 AM
  WORK_END_HOUR: parseInt(process.env.WORK_END_HOUR || '17', 10),       // 5 PM
  SLOT_INTERVAL_MIN: parseInt(process.env.SLOT_INTERVAL_MIN || '30',10),// 30-min grid
  BUFFER_MIN: parseInt(process.env.BUFFER_MIN || '10', 10),             // 10-min buffer around events
  MIN_NOTICE_MIN: parseInt(process.env.MIN_NOTICE_MIN || '120', 10)     // 2 hours notice minimum
};

// ---------- Auth Middlewares ----------
// Admin API key (protects /events/* and /freebusy and /availability)
function requireApiKey(req, res, next) {
  const keyHeader = req.get('X-API-Key');
  const bearer = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const key = keyHeader || bearer;
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Action token (for simple signed links you can click)
function requireActionToken(req, res, next) {
  const token = req.query.token || (req.get('X-Action-Token') || '').trim();
  if (!token || token !== process.env.ACTION_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized action' });
  }
  next();
}

// Optional: public summary token BEFORE admin middleware
app.get('/summary/next-week', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token || token !== process.env.SUMMARY_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { timeMin, timeMax } = nextWeekWindow();
    const items = await listEvents(timeMin, timeMax);
    const sanitized = items.map(e => ({
      id: e.id,
      when: { start: e.start, end: e.end },
      title: e.summary || 'Busy'
    }));
    res.json({ timeMin, timeMax, items: sanitized });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// From here onward, require API key for admin routes by default
app.use(requireApiKey);

// ---------- Google OAuth ----------
const oauth2 = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: 'v3', auth: oauth2 });

// ---------- Helpers ----------
function nextWeekWindow() {
  const now = new Date();
  const thisWeekMon = startOfWeek(now, { weekStartsOn: 1 }); // Monday
  const nextWeekMon = addDays(thisWeekMon, 7);
  const nextWeekSunEnd = addDays(nextWeekMon, 7);
  return { timeMin: new Date(nextWeekMon).toISOString(), timeMax: new Date(nextWeekSunEnd).toISOString() };
}

function normalizeRange({ start, end, tz = TZ_DEFAULT }) {
  if (!start || !end) throw new Error('Query params "start" and "end" are required');
  const isDateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  if (isDateOnly(start) && isDateOnly(end)) {
    const startUtc = zonedTimeToUtc(new Date(`${start}T00:00:00`), tz);
    const endUtc = zonedTimeToUtc(new Date(`${end}T23:59:59.999`), tz);
    return { timeMin: startUtc.toISOString(), timeMax: endUtc.toISOString() };
  }
  const s = parseISO(start);
  const e = parseISO(end);
  if (!isValid(s) || !isValid(e)) throw new Error('Invalid start/end; use YYYY-MM-DD or ISO datetime');
  return { timeMin: s.toISOString(), timeMax: e.toISOString() };
}

function todayRange(tz = TZ_DEFAULT) {
  const nowLocal = utcToZonedTime(new Date(), tz);
  const startLocal = startOfDay(nowLocal);
  const endLocal = endOfDay(nowLocal);
  const startUtc = zonedTimeToUtc(startLocal, tz);
  const endUtc = zonedTimeToUtc(endLocal, tz);
  return { timeMin: startUtc.toISOString(), timeMax: endUtc.toISOString() };
}

async function listEvents(timeMin, timeMax) {
  const { data } = await calendar.events.list({
    calendarId: CAL_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime'
  });
  return data.items || [];
}

async function freeBusy(timeMin, timeMax) {
  const { data } = await calendar.freebusy.query({
    requestBody: {
      timeMin, timeMax,
      items: [{ id: CAL_ID }]
    }
  });
  return data?.calendars?.[CAL_ID]?.busy || [];
}

function withinWorkHours(date, tz) {
  const local = utcToZonedTime(date, tz);
  if (!RULES.WORK_DAYS.includes(local.getDay())) return false;
  const h = local.getHours();
  return h >= RULES.WORK_START_HOUR && h < RULES.WORK_END_HOUR;
}

// Compute available start times for a day, considering busy, buffers, min notice, etc.
async function computeAvailability({ date, durationMin, tz = TZ_DEFAULT }) {
  // date: "YYYY-MM-DD"
  const dayStartLocal = setSeconds(setMinutes(setHours(new Date(date), 0), 0), 0);
  const workStartLocal = setHours(dayStartLocal, RULES.WORK_START_HOUR);
  const workEndLocal = setHours(dayStartLocal, RULES.WORK_END_HOUR);

  const timeMin = zonedTimeToUtc(workStartLocal, tz).toISOString();
  const timeMax = zonedTimeToUtc(workEndLocal, tz).toISOString();

  const busy = await freeBusy(timeMin, timeMax);

  // Build a minute-grid
  const starts = [];
  let cursorUtc = zonedTimeToUtc(workStartLocal, tz);
  const endUtc = zonedTimeToUtc(workEndLocal, tz);
  const nowUtc = new Date();

  while (cursorUtc < endUtc) {
    const slotEnd = addMinutes(cursorUtc, durationMin);
    // Must finish within work hours
    if (slotEnd > endUtc) break;

    // Respect min notice
    if (addMinutes(nowUtc, RULES.MIN_NOTICE_MIN) > cursorUtc) {
      cursorUtc = addMinutes(cursorUtc, RULES.SLOT_INTERVAL_MIN);
      continue;
    }

    // Check busy with buffer
    const slotStartBuf = addMinutes(cursorUtc, -RULES.BUFFER_MIN);
    const slotEndBuf = addMinutes(slotEnd, RULES.BUFFER_MIN);

    const overlaps = busy.some(b => {
      const bStart = new Date(b.start);
      const bEnd = new Date(b.end);
      return (slotStartBuf < bEnd) && (slotEndBuf > bStart);
    });

    if (!overlaps && withinWorkHours(cursorUtc, tz)) {
      starts.push({ startISO: cursorUtc.toISOString() });
    }

    cursorUtc = addMinutes(cursorUtc, RULES.SLOT_INTERVAL_MIN);
  }

  return starts;
}

// ---------- Health ----------
app.get('/health', (req, res) => res.send('OK'));

// ---------- Admin (API_KEY) – Events Read ----------
app.get('/events/next-week', async (req, res) => {
  try {
    const { timeMin, timeMax } = nextWeekWindow();
    const items = await listEvents(timeMin, timeMax);
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/events', async (req, res) => {
  try {
    const tz = req.query.tz || TZ_DEFAULT;
    const { timeMin, timeMax } = normalizeRange({ start: req.query.start, end: req.query.end, tz });
    const items = await listEvents(timeMin, timeMax);
    res.json(items);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/events/today', async (req, res) => {
  try {
    const tz = req.query.tz || TZ_DEFAULT;
    const { timeMin, timeMax } = todayRange(tz);
    const items = await listEvents(timeMin, timeMax);
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/freebusy', async (req, res) => {
  try {
    const tz = req.query.tz || TZ_DEFAULT;
    const { timeMin, timeMax } = normalizeRange({ start: req.query.start, end: req.query.end, tz });
    const busy = await freeBusy(timeMin, timeMax);
    res.json({ timeMin, timeMax, busy });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/availability', async (req, res) => {
  try {
    const tz = req.query.tz || TZ_DEFAULT;
    const date = req.query.date;               // YYYY-MM-DD
    const durationMin = parseInt(req.query.duration || '30', 10);
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });
    const slots = await computeAvailability({ date, durationMin, tz });
    res.json(slots);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Admin (API_KEY) – Events Write ----------
app.post('/events', async (req, res) => {
  try {
    const { summary, description, startISO, endISO, attendees = [], location, conference = true } = req.body;
    if (!summary || !startISO || !endISO) throw new Error('summary, startISO, endISO required');

    const resource = {
      summary, description, location,
      start: { dateTime: startISO },
      end: { dateTime: endISO },
      attendees
    };
    if (conference) resource.conferenceData = { createRequest: { requestId: `req-${Date.now()}` } };

    const { data } = await calendar.events.insert({
      calendarId: CAL_ID,
      resource,
      conferenceDataVersion: conference ? 1 : 0,
      sendUpdates: 'all'
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { startISO, endISO, summary, description, location, attendees, conference } = req.body;
    const resource = {};
    if (startISO || endISO) resource.start = startISO ? { dateTime: startISO } : undefined,
                             resource.end = endISO ? { dateTime: endISO } : undefined;
    if (summary !== undefined) resource.summary = summary;
    if (description !== undefined) resource.description = description;
    if (location !== undefined) resource.location = location;
    if (attendees !== undefined) resource.attendees = attendees;

    const params = {
      calendarId: CAL_ID,
      eventId: id,
      resource,
      sendUpdates: 'all'
    };
    if (conference) params.conferenceDataVersion = 1;

    const { data } = await calendar.events.patch(params);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await calendar.events.delete({ calendarId: CAL_ID, eventId: id, sendUpdates: 'all' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Simple Action Links (ACTION_TOKEN) ----------
// These are convenient GET endpoints you can click; they’re protected by ?token=ACTION_TOKEN
app.get('/action/create', requireActionToken, async (req, res) => {
  try {
    const { summary, startISO, endISO, description, location } = req.query;
    if (!summary || !startISO || !endISO) throw new Error('summary, startISO, endISO required');
    const { data } = await calendar.events.insert({
      calendarId: CAL_ID,
      resource: {
        summary, description, location,
        start: { dateTime: startISO },
        end: { dateTime: endISO }
      },
      conferenceDataVersion: 1,
      sendUpdates: 'all'
    });
    res.json({ ok: true, id: data.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/action/reschedule', requireActionToken, async (req, res) => {
  try {
    const { id, startISO, endISO, summary, description, location } = req.query;
    if (!id) throw new Error('id required');
    const resource = {};
    if (startISO) resource.start = { dateTime: startISO };
    if (endISO) resource.end = { dateTime: endISO };
    if (summary !== undefined) resource.summary = summary;
    if (description !== undefined) resource.description = description;
    if (location !== undefined) resource.location = location;

    const { data } = await calendar.events.patch({
      calendarId: CAL_ID,
      eventId: id,
      resource,
      conferenceDataVersion: 1,
      sendUpdates: 'all'
    });
    res.json({ ok: true, id: data.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/action/delete', requireActionToken, async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) throw new Error('id required');
    await calendar.events.delete({ calendarId: CAL_ID, eventId: id, sendUpdates: 'all' });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Jobs (call from Render Cron) ----------
app.post('/jobs/daily-summary', async (req, res) => {
  try {
    const tz = TZ_DEFAULT;
    const { timeMin, timeMax } = todayRange(tz);
    const items = await listEvents(timeMin, timeMax);
    // TODO: send via email/SMS (e.g., SendGrid/Vonage). For now, we just return JSON.
    res.json({ date: format(utcToZonedTime(new Date(), tz), 'yyyy-MM-dd', { timeZone: tz }), count: items.length, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/jobs/next-week-summary', async (req, res) => {
  try {
    const { timeMin, timeMax } = nextWeekWindow();
    const items = await listEvents(timeMin, timeMax);
    res.json({ timeMin, timeMax, count: items.length, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Vonage Voice (basic) ----------
// NOTE: leave these public (do NOT wrap with API_KEY). Place them AFTER app.use(requireApiKey) by using explicit handlers.
// We do a minimal signature check if VONAGE_SIGNATURE_SECRET is set.
function verifyVonageSignature(req) {
  // For production: implement full HMAC signature verification per Vonage docs.
  // Placeholder: accept if no secret configured.
  return !process.env.VONAGE_SIGNATURE_SECRET;
}

// Inbound call: Vonage "Answer URL" -> returns NCCO
app.get('/vonage/answer', (req, res) => {
  if (!verifyVonageSignature(req)) return res.status(401).end();

  const tz = TZ_DEFAULT;
  const prompt = `Hi, this is Eric's assistant. Say "book" to schedule, "list" to hear available times, or "help" for options.`;
  const ncco = [
    { action: 'talk', text: prompt },
    {
      action: 'input',
      type: ['speech', 'dtmf'],
      dtmf: { maxDigits: 1, timeOut: 5 },
      speech: { language: 'en-US', endOnSilence: 1 },
      eventUrl: [`${process.env.PUBLIC_BASE_URL}/vonage/input?tz=${encodeURIComponent(tz)}`]
    }
  ];
  res.json(ncco);
});

// Handle input: very simple intent routing for demo purposes
app.post('/vonage/input', async (req, res) => {
  if (!verifyVonageSignature(req)) return res.status(401).end();

  const tz = req.query.tz || TZ_DEFAULT;
  const utter = ((req.body && req.body.speech && req.body.speech.results && req.body.speech.results[0] && req.body.speech.results[0].text) || '').toLowerCase();

  let textOut = 'Sorry, I did not catch that. You can say book, list, or help.';
  let nextNcco = null;

  try {
    if (/\bhelp\b/.test(utter)) {
      textOut = 'Say book to schedule a time. Say list to hear available times today.';
    } else if (/\blist\b/.test(utter) || /\bavailable\b/.test(utter)) {
      // Offer the next few available 30-min slots today
      const nowLocal = utcToZonedTime(new Date(), tz);
      const yyyy = nowLocal.getFullYear();
      const mm = String(nowLocal.getMonth()+1).padStart(2,'0');
      const dd = String(nowLocal.getDate()).padStart(2,'0');
      const slots = await computeAvailability({ date: `${yyyy}-${mm}-${dd}`, durationMin: 30, tz });
      const firstFew = slots.slice(0, 5).map((s, i) => {
        const local = utcToZonedTime(new Date(s.startISO), tz);
        return `${i+1}. ${format(local, 'EEE MMM d h:mmaaa', { timeZone: tz })}`;
      });
      if (firstFew.length === 0) {
        textOut = 'No openings left today. Say book to try another day.';
      } else {
        textOut = `Here are some times: ${firstFew.join('. ')}. Say book and then say the number you want.`;
      }
    } else if (/\bbook\b/.test(utter)) {
      textOut = 'Okay, say a date like "this Friday" or "August 20th", then a time like 3 PM, or say today.';
      // In a real system, you’d do NLU; here we keep it simple for the demo.
    }
  } catch (e) {
    textOut = 'I hit a snag checking availability. Please try again later.';
  }

  const ncco = [
    { action: 'talk', text: textOut },
    {
      action: 'input',
      type: ['speech', 'dtmf'],
      dtmf: { maxDigits: 1, timeOut: 5 },
      speech: { language: 'en-US', endOnSilence: 1 },
      eventUrl: [`${process.env.PUBLIC_BASE_URL}/vonage/input?tz=${encodeURIComponent(tz)}`]
    }
  ];
  res.json(ncco);
});

// Optional: trigger outbound call (requires Vonage app + private key)
app.post('/vonage/call/start', async (req, res) => {
  try {
    const { toNumber } = req.body;
    if (!process.env.VONAGE_APPLICATION_ID || !process.env.VONAGE_PRIVATE_KEY_B64) {
      return res.status(400).json({ error: 'Vonage credentials not configured' });
    }
    const privateKey = Buffer.from(process.env.VONAGE_PRIVATE_KEY_B64, 'base64').toString('utf8');
    const token = jwt.sign(
      {
        application_id: process.env.VONAGE_APPLICATION_ID,
        iat: Math.floor(Date.now()/1000),
        exp: Math.floor(Date.now()/1000) + 60 * 5,
        jti: `jwt-${Date.now()}`
      },
      privateKey,
      { algorithm: 'RS256' }
    );
    await axios.post('https://api.nexmo.com/v1/calls', {
      to: [{ type: 'phone', number: toNumber }],
      from: { type: 'phone', number: process.env.VONAGE_NUMBER },
      answer_url: [`${process.env.PUBLIC_BASE_URL}/vonage/answer`]
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Calendar assistant running on port ${PORT}`);
});
