// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { google } = require('googleapis');
const {
  startOfWeek,
  addDays,
  startOfDay,
  endOfDay,
  parseISO,
  isValid,
} = require('date-fns');
const { zonedTimeToUtc } = require('date-fns-tz');

const app = express();
app.use(bodyParser.json());

// --- Security hardening ---
app.use(helmet());
app.use(
  rateLimit({
    windowMs: 60_000, // 1 minute
    max: 60,          // 60 requests per IP per minute
  })
);

// --- Simple API key auth middleware (protect all routes) ---
function requireApiKey(req, res, next) {
  const keyHeader = req.get('X-API-Key');
  const bearer = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const key = keyHeader || bearer;
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
app.use(requireApiKey);

// --- Google OAuth2 client ---
const oauth2 = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const calendar = google.calendar({ version: 'v3', auth: oauth2 });
const CAL_ID = process.env.CALENDAR_ID || 'primary';

// --- Helpers ---

// Monday–Sunday of next week (UTC ISO bounds)
function nextWeekWindow() {
  const now = new Date();
  const thisWeekMon = startOfWeek(now, { weekStartsOn: 1 }); // Monday
  const nextWeekMon = addDays(thisWeekMon, 7);
  const nextWeekSunEnd = addDays(nextWeekMon, 7);
  return {
    timeMin: new Date(nextWeekMon).toISOString(),
    timeMax: new Date(nextWeekSunEnd).toISOString(),
  };
}

// Normalize a date/datetime range into ISO UTC strings Google accepts.
// Supports:
//   - start=YYYY-MM-DD&end=YYYY-MM-DD (interpreted in tz, default America/Chicago)
//   - start=<ISO datetime>&end=<ISO datetime>
function normalizeRange({ start, end, tz = 'America/Chicago' }) {
  if (!start || !end) throw new Error('Query params "start" and "end" are required');

  const isDateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  if (isDateOnly(start) && isDateOnly(end)) {
    const startUtc = zonedTimeToUtc(new Date(`${start}T00:00:00`), tz);
    const endUtc = zonedTimeToUtc(new Date(`${end}T23:59:59.999`), tz);
    return { timeMin: startUtc.toISOString(), timeMax: endUtc.toISOString() };
  }

  // Otherwise expect valid ISO datetimes with offsets/timezones
  const s = parseISO(start);
  const e = parseISO(end);
  if (!isValid(s) || !isValid(e)) throw new Error('Invalid start/end; use YYYY-MM-DD or ISO datetime');
  return { timeMin: s.toISOString(), timeMax: e.toISOString() };
}

// Today (start/end) in a given timezone (default America/Chicago)
function todayRange(tz = 'America/Chicago') {
  const now = new Date();
  const startUtc = zonedTimeToUtc(startOfDay(now), tz);
  const endUtc = zonedTimeToUtc(endOfDay(now), tz);
  return { timeMin: startUtc.toISOString(), timeMax: endUtc.toISOString() };
}

// --- Routes ---

// Health check
app.get('/health', (req, res) => res.send('OK'));

// List events: next week (kept for convenience)
app.get('/events/next-week', async (req, res) => {
  try {
    const { timeMin, timeMax } = nextWeekWindow();
    const { data } = await calendar.events.list({
      calendarId: CAL_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });
    res.json(data.items || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Flexible range: GET /events?start=YYYY-MM-DD&end=YYYY-MM-DD[&tz=America/Chicago]
// Or ISO datetimes: /events?start=2025-08-11T09:00:00-05:00&end=2025-08-12T17:00:00-05:00
app.get('/events', async (req, res) => {
  try {
    const tz = req.query.tz || 'America/Chicago';
    const { timeMin, timeMax } = normalizeRange({
      start: req.query.start,
      end: req.query.end,
      tz,
    });
    const { data } = await calendar.events.list({
      calendarId: CAL_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });
    res.json(data.items || []);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Today convenience: GET /events/today[?tz=America/Chicago]
app.get('/events/today', async (req, res) => {
  try {
    const tz = req.query.tz || 'America/Chicago';
    const { timeMin, timeMax } = todayRange(tz);
    const { data } = await calendar.events.list({
      calendarId: CAL_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });
    res.json(data.items || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Free/busy blocks (no titles/attendees): GET /freebusy?start=YYYY-MM-DD&end=YYYY-MM-DD[&tz=America/Chicago]
app.get('/freebusy', async (req, res) => {
  try {
    const tz = req.query.tz || 'America/Chicago';
    const { timeMin, timeMax } = normalizeRange({
      start: req.query.start,
      end: req.query.end,
      tz,
    });

    const { data } = await calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        items: [{ id: CAL_ID }],
      },
    });

    const busy = data?.calendars?.[CAL_ID]?.busy || [];
    // busy is an array of { start: ISOString, end: ISOString }
    res.json({ timeMin, timeMax, busy });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Create event
app.post('/events', async (req, res) => {
  try {
    const {
      summary,
      description,
      startISO,
      endISO,
      attendees = [],
      location,
      conference = true,
    } = req.body;

    const resource = {
      summary,
      description,
      location,
      start: { dateTime: startISO },
      end: { dateTime: endISO },
      attendees,
    };
    if (conference) {
      resource.conferenceData = {
        createRequest: { requestId: `req-${Date.now()}` },
      };
    }

    const { data } = await calendar.events.insert({
      calendarId: CAL_ID,
      resource,
      conferenceDataVersion: conference ? 1 : 0,
      sendUpdates: 'all',
    });

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reschedule (move) event
app.patch('/events/:id/reschedule', async (req, res) => {
  try {
    const { id } = req.params;
    const { startISO, endISO } = req.body;

    const { data } = await calendar.events.patch({
      calendarId: CAL_ID,
      eventId: id,
      resource: {
        start: { dateTime: startISO },
        end: { dateTime: endISO },
      },
      sendUpdates: 'all',
    });

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cancel (delete) event
app.delete('/events/:id', async (req, res) => {
  try {
    const { id } = req.params;

    await calendar.events.delete({
      calendarId: CAL_ID,
      eventId: id,
      sendUpdates: 'all',
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Calendar assistant running on port ${PORT}`);
});
