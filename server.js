require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { GarminConnect } = require('garmin-connect');

const app = express();
app.use(cors()); // erlaubt dem Dashboard (jede Domain) den Zugriff
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, 'cache.json');
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 Minuten zwischen echten Garmin-Abfragen pro Tag

let gc = null;
let displayName = null;
let loginPromise = null;

/* ---------- Login (mit Wiederverwendung der Session) ---------- */
async function ensureLogin() {
  if (gc && displayName) return;
  if (loginPromise) return loginPromise;

  loginPromise = (async () => {
    if (!process.env.GARMIN_EMAIL || !process.env.GARMIN_PASSWORD) {
      throw new Error('GARMIN_EMAIL / GARMIN_PASSWORD nicht gesetzt (Environment Variables fehlen)');
    }
    const client = new GarminConnect({
      username: process.env.GARMIN_EMAIL,
      password: process.env.GARMIN_PASSWORD,
    });
    await client.login();
    const profile = await client.getUserProfile();
    gc = client;
    displayName = profile.displayName || profile.userName;
    console.log('Garmin-Login erfolgreich für', displayName);
  })();

  try {
    await loginPromise;
  } finally {
    loginPromise = null;
  }
}

/* ---------- Cache (Datei, überlebt Neustarts auf Render nicht zwingend, aber spart Garmin-Anfragen) ---------- */
function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return {}; }
}
function writeCache(data) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('Cache konnte nicht geschrieben werden:', e.message); }
}

function pick(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

function toGarminDateStr(dateStr) {
  // Garmin erwartet YYYY-MM-DD
  return dateStr;
}

/* ---------- Tageswerte holen ---------- */
async function fetchDay(dateStr) {
  await ensureLogin();
  const result = { date: dateStr };
  const d = toGarminDateStr(dateStr);

  // 1) Tagesübersicht: RHR, Kalorien, Schritte, Stress, Body Battery
  try {
    const url = `https://connect.garmin.com/modern/proxy/usersummary-service/usersummary/daily/${displayName}`;
    const summary = await gc.get(url, { calendarDate: d });
    result.rhr = pick(summary, ['restingHeartRate']);
    result.calories = pick(summary, ['activeKilocalories', 'totalKilocalories']);
    result.steps = pick(summary, ['totalSteps']);
    result.stress = pick(summary, ['averageStressLevel']);
    result.bodyBattery = pick(summary, ['bodyBatteryMostRecentValue', 'bodyBatteryHighestValue']);
  } catch (e) {
    console.error(`[${dateStr}] Tagesübersicht-Fehler:`, e.message);
  }

  // 2) Schlaf
  try {
    const sleep = await gc.getSleepData(new Date(d + 'T00:00:00'));
    const dto = sleep && (sleep.dailySleepDTO || sleep);
    const seconds = pick(dto, ['sleepTimeSeconds', 'sleepSeconds']);
    if (seconds) result.sleepHours = +(seconds / 3600).toFixed(2);
    const overall = dto && dto.sleepScores && dto.sleepScores.overall;
    const overallVal = overall && (overall.value !== undefined ? overall.value : overall);
    if (typeof overallVal === 'number') result.sleepScore = overallVal;
  } catch (e) {
    console.error(`[${dateStr}] Schlaf-Fehler:`, e.message);
  }

  // 3) HRV (separater interner Endpunkt, nicht offiziell dokumentiert -> kann brechen)
  try {
    const hrvUrl = `https://connect.garmin.com/modern/proxy/hrv-service/hrv/daily/${d}/${d}`;
    const hrv = await gc.get(hrvUrl);
    const entry = Array.isArray(hrv) ? hrv[0] : hrv;
    const val = entry && entry.hrvSummary && (entry.hrvSummary.lastNightAvg ?? entry.hrvSummary.weeklyAvg);
    if (typeof val === 'number') result.hrv = val;
  } catch (e) {
    // HRV ist oft nicht verfügbar (Gerät/Account-abhängig) -- kein Abbruch
  }

  // 4) Ø Herzfrequenz über den Tag (best effort)
  try {
    const hr = await gc.getHeartRate(new Date(d + 'T00:00:00'));
    const avg = pick(hr, ['averageHeartRate', 'avgHeartRate']);
    if (typeof avg === 'number') result.avgHeartRate = avg;
  } catch (e) {
    // ignorieren
  }

  return result;
}

/* ---------- Routen ---------- */
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/today', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const cache = readCache();
    const cached = cache[today];
    if (cached && Date.now() - (cached._fetchedAt || 0) < CACHE_TTL_MS) {
      return res.json(cached);
    }
    const data = await fetchDay(today);
    data._fetchedAt = Date.now();
    cache[today] = data;
    writeCache(cache);
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/history', async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '14', 10), 60);
  const cache = readCache();
  const out = [];
  try {
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      let entry = cache[dateStr];
      const stale = !entry || Date.now() - (entry._fetchedAt || 0) > 24 * 60 * 60 * 1000;
      if (stale) {
        entry = await fetchDay(dateStr);
        entry._fetchedAt = Date.now();
        cache[dateStr] = entry;
      }
      out.push(entry);
    }
    writeCache(cache);
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message, partial: out });
  }
});

app.listen(PORT, () => console.log(`Garmin-Sync-Server läuft auf Port ${PORT}`));
