require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const { startOfWeek, addDays, startOfDay, endOfDay, parseISO, isValid } = require('date-fns');
const { zonedTimeToUtc } = require('date-fns-tz');


const app = express();

// --- Simple API key auth middleware ---
function requireApiKey(req, res, next) {
  const key = req.get('X-API-Key') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Normalize a date or datetime range into ISO strings Google accepts.
// Supports:
//   - start=YYYY-MM-DD&end=YYYY-MM-DD (interpreted in a tz, default America/Chicago)
//   - start=<ISO datetime>&end=<ISO datetime>
function normalizeRange({ start, end, tz = 'America/Chicago' }) {
  if (!start || !end) throw new Error('Query params "start" and "end" are required');

  const isDateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  if (isDateOnly(start) && isDateOnly(end)) {
    // Treat as full-day bounds in the given timezone
    const startUtc = zonedTimeToUtc(new Date(`${start}T00:00:00`), tz);
    const endUtc = zonedTimeToUtc(new Date(`${end}T23:59:59.999`), tz);
    return { timeMin: startUtc.toISOString(), timeMax: endUtc.toISOString() };
  }

  // Otherwise expect valid ISO datetimes
  const s = parseISO(start);
  const e = parseISO(end);
  if (!isValid(s) || !isValid(e)) throw new Error('Invalid start/end; use YYYY-MM-DD or ISO datetime');
  return { timeMin: s.toISOString(), timeMax: e.toISOString() };
}

// Today in a timezone
function todayRange(tz = 'America/Chicago') {
  const now = new Date();
  const startUtc = zonedTimeToUtc(startOfDay(now), tz);
  const endUtc = zonedTimeToUtc(endOfDay(now), tz);
  return { timeMin: startUtc.toISOString(), timeMax: endUtc.toISOString() };
}

// Apply to all routes
app.use(requireApiKey);

app.use(bodyParser.json());

// GET /events?start=YYYY-MM-DD&end=YYYY-MM-DD[&tz=America/Chicago]
// or /events?start=2025-08-11T09:00:00-05:00&end=2025-08-12T17:00:00-05:00
app.get('/events', async (req, res) => {
  try {
    const tz = req.query.tz || 'America/Chicago';
    const { timeMin, timeMax } = normalizeRange({
      start: req.query.start,
      end: req.query.end,
      tz
    });
    const { data } = await calendar.events.list({
      calendarId: CAL_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime'
    });
    res.json(data.items || []);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// Google OAuth2 client
const oauth2 = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const calendar = google.calendar({ version: 'v3', auth: oauth2 });
const CAL_ID = process.env.CALENDAR_ID || 'primary';

// Helper: Get Monday–Sunday of next week
function nextWeekWindow() {
  const now = new Date();
  const thisWeekMon = startOfWeek(now, { weekStartsOn: 1 });
  const nextWeekMon = addDays(thisWeekMon, 7);
  const nextWeekSunEnd = addDays(nextWeekMon, 7);
  return {
    timeMin: new Date(nextWeekMon).toISOString(),
    timeMax: new Date(nextWeekSunEnd).toISOString(),
  };
}

// Endpoint: List next week's events
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

// Endpoint: Create new event
app.post('/events', async (req, res) => {
  try {
    const { summary, description, startISO, endISO, attendees = [], location, conference = true } = req.body;
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
        createRequest: { requestId: `req-${Date.now()}` }
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

// Endpoint: Reschedule (update) event
app.patch('/events/:id/reschedule', async (req, res) => {
  try {
    const { id } = req.params;
    const { startISO, endISO } = req.body;
    const { data } = await calendar.events.patch({
      calendarId: CAL_ID,
      eventId: id,
      resource: { start: { dateTime: startISO }, end: { dateTime: endISO } },
      sendUpdates: 'all',
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /events/today[?tz=America/Chicago]
app.get('/events/today', async (req, res) => {
  try {
    const tz = req.query.tz || 'America/Chicago';
    const { timeMin, timeMax } = todayRange(tz);
    const { data } = await calendar.events.list({
      calendarId: CAL_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime'
    });
    res.json(data.items || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// Endpoint: Cancel (delete) event
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

// Health check
app.get('/health', (req, res) => {
  res.send('OK');
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Calendar assistant running on port ${PORT}`);
});


