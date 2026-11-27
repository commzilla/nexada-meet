import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const FROM = process.env.EMAIL_FROM || 'Nexada Meet <meet@nexada.co>';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'google-token.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const esc = (s = '') => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- signed meeting links ---------- */
const SECRET = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'dev-secret';
const OPEN_BEFORE_SEC = 30 * 60; // guests can join 30 min before start
const GRACE_AFTER_SEC = 60 * 60; // link stays valid 1h after end
const sign = (s, e, o) => crypto.createHmac('sha256', SECRET).update(`${s}.${e}.${o}`).digest('hex').slice(0, 32);
const makeLink = (startMs, endMs, owner = 0) => {
  const s = Math.floor(startMs / 1000), e = Math.floor(endMs / 1000);
  return `${APP_URL}/room?s=${s}&e=${e}&o=${owner}&sig=${sign(s, e, owner)}`;
};
function verifyLink(q) {
  const s = parseInt(q.s), e = parseInt(q.e), o = q.o === '1' ? 1 : 0;
  if (!s || !e || !q.sig) return null;
  const good = Buffer.from(sign(s, e, o)), got = Buffer.from(String(q.sig));
  if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) return null;
  return { s, e, o };
}

/* ---------- auth for host area ---------- */
function auth(req, res, next) {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) return res.status(500).send('Set ADMIN_PASSWORD in your environment.');
  const h = req.headers.authorization || '';
  const [u, p] = Buffer.from(h.split(' ')[1] || '', 'base64').toString().split(':');
  if (u === (process.env.ADMIN_USER || 'admin') && p === pass) return next();
  res.set('WWW-Authenticate', 'Basic realm="Nexada Meet"').status(401).send('Authentication required');
}

/* ---------- Daily default room ---------- */
let roomCache = null;
async function daily(pathname, opts = {}) {
  const r = await fetch('https://api.daily.co/v1' + pathname, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.DAILY_API_KEY}`, 'Content-Type': 'application/json' }
  });
  if (!r.ok) throw new Error(`Daily ${r.status}: ${await r.text()}`);
  return r.json();
}
async function getRoomUrl() {
  if (process.env.DAILY_ROOM_URL) return process.env.DAILY_ROOM_URL;
  if (roomCache) return roomCache;
  const rooms = await daily('/rooms?limit=1');
  if (rooms.data?.length) return (roomCache = rooms.data[0].url);
  const created = await daily('/rooms', { method: 'POST', body: JSON.stringify({ name: 'nexada-meet', privacy: 'public' }) });
  return (roomCache = created.url);
}

/* ---------- Google Calendar ---------- */
const oauth = () => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `${APP_URL}/auth/google/callback`
);
const googleConnected = () => !!process.env.GOOGLE_REFRESH_TOKEN || fs.existsSync(TOKEN_FILE);
const googleTokens = () => process.env.GOOGLE_REFRESH_TOKEN ? { refresh_token: process.env.GOOGLE_REFRESH_TOKEN } : JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));

app.get('/auth/google', auth, (req, res) => {
  const url = oauth().generateAuthUrl({
    access_type: 'offline', prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events']
  });
  res.redirect(url);
});
app.get('/auth/google/callback', auth, async (req, res) => {
  try {
    const c = oauth();
    const { tokens } = await c.getToken(req.query.code);
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens));
    res.send(`<body style="background:#07050d;color:#fff;font-family:sans-serif;padding:30px;max-width:640px;margin:auto"><h2>Google Calendar connected</h2>
<p>To keep it connected after restarts on free hosting, add this environment variable in Render, then redeploy:</p>
<p><b>GOOGLE_REFRESH_TOKEN</b></p><textarea readonly style="width:100%;height:90px;background:#17112a;color:#fff;border:1px solid #2a1f47;padding:10px">${tokens.refresh_token || 'No refresh token returned. Remove the app at myaccount.google.com/permissions and connect again.'}</textarea>
<p><a style="color:#c4b5fd" href="/host">Back to dashboard</a></p></body>`);
  } catch (e) { res.status(500).send('Google error: ' + e.message); }
});

async function addToGoogle({ title, start, end, attendees, joinUrl, description, hostName }) {
  const c = oauth();
  c.setCredentials(googleTokens());
  const cal = google.calendar({ version: 'v3', auth: c });
  const r = await cal.events.insert({
    calendarId: 'primary',
    sendUpdates: 'none', // we send our own branded email
    requestBody: {
      summary: title,
      description: `${description ? description + '\n\n' : ''}Join video call: ${joinUrl}`,
      location: joinUrl,
      start: { dateTime: start }, end: { dateTime: end },
      attendees: attendees.map(email => ({ email })),
      source: { title: 'Nexada Meet', url: joinUrl },
      extendedProperties: { private: { nexadaMeet: '1', hostName: hostName || '' } }
    }
  });
  return r.data;
}

/* ---------- meeting store (file) + Google merge ---------- */
const MEET_FILE = path.join(DATA_DIR, 'meetings.json');
const readMeetings = () => { try { return JSON.parse(fs.readFileSync(MEET_FILE, 'utf8')); } catch { return []; } };
const writeMeetings = list => fs.writeFileSync(MEET_FILE, JSON.stringify(list, null, 1));

async function listGoogleMeetings() {
  const c = oauth();
  c.setCredentials(googleTokens());
  const cal = google.calendar({ version: 'v3', auth: c });
  const r = await cal.events.list({
    calendarId: 'primary', singleEvents: true, orderBy: 'startTime', maxResults: 100,
    timeMin: new Date(Date.now() - 6 * 3600e3).toISOString(),
    privateExtendedProperty: 'nexadaMeet=1'
  });
  return (r.data.items || []).filter(e => e.status !== 'cancelled').map(e => ({
    id: e.id, googleEventId: e.id, title: e.summary || '(no title)',
    start: e.start?.dateTime, end: e.end?.dateTime,
    attendees: (e.attendees || []).map(a => a.email),
    description: (e.description || '').replace(/\n*Join video call:[\s\S]*$/, '').trim(),
    joinUrl: e.location || '', hostName: e.extendedProperties?.private?.hostName || ''
  }));
}
async function allMeetings() {
  let g = [], gErr = null;
  if (googleConnected()) { try { g = await listGoogleMeetings(); } catch (e) { gErr = e.message; } }
  const gids = new Set(g.map(m => m.googleEventId));
  const cutoff = Date.now() - 6 * 3600e3;
  const local = readMeetings().filter(m => new Date(m.end).getTime() > cutoff && !(m.googleEventId && gids.has(m.googleEventId)));
  // Local entries that Google also has: keep Google's version (richer, survives restarts)
  const list = [...g, ...local].sort((a, b) => new Date(a.start) - new Date(b.start));
  return { list, gErr };
}

function cancelHtml({ title, whenText, hostName }) {
  return `<!doctype html><html><body style="margin:0;background:#07050d;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07050d;padding:32px 12px;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#0f0b1a;border:1px solid #2a1f47;border-radius:20px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
<tr><td style="height:4px;background:linear-gradient(90deg,#7c4dff,#c084fc);font-size:0;">&nbsp;</td></tr>
<tr><td style="padding:32px 36px 8px;"><img src="${APP_URL}/logo.png" width="44" alt="Nexada" style="display:block;"></td></tr>
<tr><td style="padding:8px 36px 30px;"><p style="margin:0 0 6px;color:#f87171;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:600;">Meeting cancelled</p>
<h1 style="margin:0;color:#fff;font-size:24px;">${esc(title)}</h1>
<p style="margin:12px 0 0;color:#b9b2cc;font-size:15px;line-height:1.6;">${esc(hostName || 'The host')} cancelled this meeting.<br>It was scheduled for ${esc(whenText)}. The old link no longer needs to be used.</p>
<p style="margin:24px 0 0;color:#6f6688;font-size:12px;">Nexada Meet &middot; <a href="https://nexada.co" style="color:#8f86a8;">nexada.co</a></p></td></tr>
</table></td></tr></table></body></html>`;
}

/* ---------- ICS + email ---------- */
const icsDate = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function makeIcs({ title, start, end, joinUrl, description, uid }) {
  const fold = s => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Nexada//Meet//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    `UID:${uid}@nexada.co`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:${fold(title)}`, `DESCRIPTION:${fold((description ? description + '\n\n' : '') + 'Join: ' + joinUrl)}`,
    `LOCATION:${fold(joinUrl)}`, `URL:${joinUrl}`, 'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
}

function emailHtml({ title, whenText, hostName, joinUrl, gcalUrl, description }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#07050d;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07050d;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#0f0b1a;border:1px solid #2a1f47;border-radius:20px;overflow:hidden;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
<tr><td style="height:4px;background:linear-gradient(90deg,#7c4dff,#c084fc);font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:32px 36px 8px;"><img src="${APP_URL}/logo.png" width="44" alt="Nexada" style="display:block;border:0;"></td></tr>
<tr><td style="padding:8px 36px 0;">
  <p style="margin:0 0 6px;color:#a78bfa;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:600;">You're invited</p>
  <h1 style="margin:0;color:#ffffff;font-size:26px;line-height:1.25;font-weight:700;">${esc(title)}</h1>
  <p style="margin:12px 0 0;color:#b9b2cc;font-size:15px;line-height:1.6;">${esc(hostName)} invited you to a video meeting.</p>
</td></tr>
<tr><td style="padding:24px 36px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#17112a;border:1px solid #2a1f47;border-radius:14px;">
    <tr><td style="padding:16px 20px;">
      <p style="margin:0;color:#8f86a8;font-size:12px;text-transform:uppercase;letter-spacing:.1em;">When</p>
      <p style="margin:4px 0 0;color:#fff;font-size:16px;font-weight:600;">${esc(whenText)}</p>
    </td></tr>
    ${description ? `<tr><td style="padding:0 20px 16px;"><p style="margin:0;color:#8f86a8;font-size:12px;text-transform:uppercase;letter-spacing:.1em;">Details</p><p style="margin:4px 0 0;color:#d6d0e6;font-size:14px;line-height:1.55;">${esc(description).replace(/\n/g, '<br>')}</p></td></tr>` : ''}
  </table>
</td></tr>
<tr><td align="center" style="padding:28px 36px 8px;">
  <a href="${joinUrl}" style="display:inline-block;background:linear-gradient(135deg,#7c4dff,#a855f7);background-color:#7c4dff;color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:15px 38px;border-radius:12px;">Join meeting</a>
</td></tr>
<tr><td align="center" style="padding:10px 36px 0;"><p style="margin:0;color:#8f86a8;font-size:13px;">The room opens 30 minutes before the start time.</p></td></tr>
<tr><td align="center" style="padding:8px 36px 0;">
  <a href="${gcalUrl}" style="color:#a78bfa;font-size:14px;text-decoration:none;">+ Add to Google Calendar</a>
</td></tr>
<tr><td style="padding:24px 36px 8px;">
  <p style="margin:0;color:#8f86a8;font-size:12px;line-height:1.6;">Or copy this link:<br><a href="${joinUrl}" style="color:#c4b5fd;word-break:break-all;">${joinUrl}</a></p>
</td></tr>
<tr><td style="padding:20px 36px 30px;border-top:1px solid #231a3d;">
  <p style="margin:18px 0 0;color:#6f6688;font-size:12px;">Sent with Nexada Meet &middot; <a href="https://nexada.co" style="color:#8f86a8;">nexada.co</a></p>
</td></tr>
</table></td></tr></table></body></html>`;
}

async function sendEmail({ to, subject, html, ics }) {
  const body = { from: FROM, to: [to], subject, html };
  if (ics) body.attachments = [{ filename: 'invite.ics', content: Buffer.from(ics).toString('base64') }];
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

/* ---------- API ---------- */
app.get('/api/room', async (req, res) => {
  try {
    const link = verifyLink(req.query);
    if (!link) return res.status(403).json({ error: 'invalid', message: 'Please use the link from your invitation.' });
    const now = Math.floor(Date.now() / 1000);
    const opensAt = link.s - OPEN_BEFORE_SEC;
    if (now < opensAt) return res.status(425).json({ error: 'early', opensAt: opensAt * 1000, start: link.s * 1000 });
    if (now > link.e + GRACE_AFTER_SEC) return res.status(410).json({ error: 'ended', message: 'This meeting has ended.' });
    const url = await getRoomUrl();
    const roomName = new URL(url).pathname.replace(/^\//, '');
    const tk = await daily('/meeting-tokens', {
      method: 'POST',
      body: JSON.stringify({ properties: { room_name: roomName, is_owner: !!link.o, exp: link.e + GRACE_AFTER_SEC } })
    });
    res.json({ url: `${url}?t=${tk.token}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Instant meeting for the host: owner link + guest link, valid 4 hours
app.get('/api/instant', auth, (req, res) => {
  const now = Date.now(), end = now + 4 * 3600 * 1000;
  res.json({ hostUrl: makeLink(now, end, 1), guestUrl: makeLink(now, end, 0) });
});

app.get('/api/meetings', auth, async (req, res) => {
  try { res.json(await allMeetings()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/meetings/:id', auth, async (req, res) => {
  try {
    const { list } = await allMeetings();
    const m = list.find(x => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'Meeting not found' });
    if (m.googleEventId && googleConnected()) {
      try {
        const c = oauth(); c.setCredentials(googleTokens());
        await google.calendar({ version: 'v3', auth: c }).events.delete({ calendarId: 'primary', eventId: m.googleEventId, sendUpdates: 'none' });
      } catch (e) { /* already gone */ }
    }
    writeMeetings(readMeetings().filter(x => x.id !== m.id && x.googleEventId !== m.googleEventId));
    const whenText = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: m.tz || 'UTC' }).format(new Date(m.start)) + ` (${(m.tz || 'UTC').replace('_', ' ')})`;
    const html = cancelHtml({ title: m.title, whenText, hostName: m.hostName });
    const results = [];
    for (const to of m.attendees || []) {
      try { await sendEmail({ to, subject: `Cancelled: ${m.title}`, html }); results.push({ to, ok: true }); }
      catch (e) { results.push({ to, ok: false, error: e.message }); }
    }
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/status', auth, (req, res) => res.json({ google: googleConnected(), googleConfigured: !!process.env.GOOGLE_CLIENT_ID }));

app.post('/api/schedule', auth, async (req, res) => {
  try {
    const { title, start, durationMin = 30, attendees = [], description = '', hostName = 'Nexada', tz = 'UTC' } = req.body;
    if (!title || !start || !attendees.length) return res.status(400).json({ error: 'Title, time and at least one email are required.' });
    const startD = new Date(start);
    const endD = new Date(startD.getTime() + durationMin * 60000);
    const joinUrl = makeLink(startD.getTime(), endD.getTime(), 0);
    const whenText = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(startD)
      + ` (${tz.replace('_', ' ')}) · ${durationMin} min`;
    const gcalUrl = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
      + `&text=${encodeURIComponent(title)}&dates=${icsDate(startD)}/${icsDate(endD)}`
      + `&details=${encodeURIComponent('Join video call: ' + joinUrl)}&location=${encodeURIComponent(joinUrl)}`;
    const ics = makeIcs({ title, start: startD, end: endD, joinUrl, description, uid: Date.now() + '-' + Math.random().toString(36).slice(2) });
    const html = emailHtml({ title, whenText, hostName, joinUrl, gcalUrl, description });

    const results = await Promise.all(attendees.map(to =>
      sendEmail({ to, subject: `Invitation: ${title}`, html, ics })
        .then(() => ({ to, ok: true }))
        .catch(e => { console.error('Resend error', to, e.message); return { to, ok: false, error: e.message }; })
    ));
    let calendarLink = null, calendarError = null, googleEventId = null;
    if (googleConnected()) {
      try {
        const ev = await addToGoogle({ title, start: startD.toISOString(), end: endD.toISOString(), attendees, joinUrl, description, hostName });
        calendarLink = ev.htmlLink; googleEventId = ev.id;
      } catch (e) { calendarError = e.message; }
    }
    const saved = readMeetings();
    saved.push({ id: crypto.randomUUID(), title, start: startD.toISOString(), end: endD.toISOString(), attendees, description, hostName, tz, joinUrl, googleEventId });
    writeMeetings(saved.slice(-200));
    res.json({ results, calendarLink, calendarError, joinUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- pages ---------- */
app.get('/host', auth, (req, res) => res.sendFile(path.join(__dirname, 'public/host.html')));
app.get('/room', (req, res) => res.sendFile(path.join(__dirname, 'public/room.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

app.listen(PORT, () => console.log(`Nexada Meet running on ${APP_URL}`));
