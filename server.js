require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const { startOfWeek, addDays } = require('date-fns');

const app = express();

// --- Simple API key auth middleware ---
function requireApiKey(req, res, next) {
  const key = req.get('X-API-Key') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Apply to all routes
app.use(requireApiKey);

app.use(bodyParser.json());

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

