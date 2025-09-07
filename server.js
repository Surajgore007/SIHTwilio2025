/**
 * server.js - Updated: WhatsApp support + media handling + proper channel detection
 */
const express = require('express');
const dotenv = require('dotenv');
const twilio = require('twilio');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const morgan = require('morgan');

dotenv.config();

const PORT = process.env.PORT || 3000;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || '';
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || ''; // WhatsApp sender number
const TWILIO_WEBHOOK_URL = process.env.TWILIO_WEBHOOK_URL || '';

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.warn('⚠️ Please set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER in .env');
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(morgan('dev'));

// Create media directory if it doesn't exist
const MEDIA_DIR = './media';
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  console.log(`Created media directory: ${MEDIA_DIR}`);
}

// Serve media files statically
app.use('/media', express.static(MEDIA_DIR));

// IMPORTANT: capture raw body buffer for Twilio signature validation
app.use(express.urlencoded({
  extended: false,
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

app.use(express.json());

// --- simple storage ---
let reports = [];
const REPORTS_FILE = './reports.json';
try {
  if (fs.existsSync(REPORTS_FILE)) {
    reports = JSON.parse(fs.readFileSync(REPORTS_FILE)) || [];
    console.log(`Loaded ${reports.length} reports`);
  }
} catch (e) {
  console.warn('Could not load reports file:', e.message);
}
function persistReports() {
  try { fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports, null, 2)); }
  catch (e) { console.error('Failed to persist reports:', e.message); }
}

// Helper: detect if message is from WhatsApp or SMS
function getChannelInfo(fromNumber) {
  const isWhatsApp = fromNumber && fromNumber.startsWith('whatsapp:');
  return {
    isWhatsApp,
    cleanNumber: isWhatsApp ? fromNumber.replace('whatsapp:', '') : fromNumber,
    channel: isWhatsApp ? 'whatsapp' : 'sms'
  };
}

// Helper: download media from Twilio
async function downloadMedia(mediaUrl, mediaContentType, reportId) {
  if (!mediaUrl || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;

  try {
    console.log(`Downloading media: ${mediaUrl}`);
    
    // Twilio media URLs require authentication
    const response = await fetch(mediaUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')
      }
    });

    if (!response.ok) {
      console.error(`Failed to download media: ${response.status} ${response.statusText}`);
      return null;
    }

    // Determine file extension from content type
    const ext = getFileExtension(mediaContentType);
    const filename = `${reportId}_${Date.now()}${ext}`;
    const filepath = path.join(MEDIA_DIR, filename);

    // Save file
    const buffer = await response.buffer();
    fs.writeFileSync(filepath, buffer);

    console.log(`Media saved: ${filepath} (${buffer.length} bytes)`);
    
    return {
      filename,
      filepath,
      size: buffer.length,
      contentType: mediaContentType,
      url: `/media/${filename}` // URL to access the file
    };
  } catch (error) {
    console.error('Error downloading media:', error.message);
    return null;
  }
}

// Helper: get file extension from content type
function getFileExtension(contentType) {
  const extensions = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'application/pdf': '.pdf',
    'text/plain': '.txt'
  };
  return extensions[contentType] || '.bin';
}

// geocode helper (same as before)
let lastGeoTs = 0;
async function geocodeLocation(place) {
  if (!place || place === 'Unknown location') return null;
  if (!global._geoCache) global._geoCache = {};
  if (global._geoCache[place]) return global._geoCache[place];

  const waitMs = Math.max(0, 1100 - (Date.now() - lastGeoTs));
  if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
  lastGeoTs = Date.now();

  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=1`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'OceanSaksham/1.0 (demo@example.com)' }});
    const json = await res.json();
    if (json && json.length) {
      const coords = { lat: parseFloat(json[0].lat), lon: parseFloat(json[0].lon) };
      global._geoCache[place] = coords;
      return coords;
    }
  } catch (e) { console.error('Geocode error:', e.message); }
  return null;
}

// parser + save + send functions
function parseHazardReport(messageBody) {
  const hazardTypes = {
    flood: ['flood', 'flooding', 'inundation'],
    tsunami: ['tsunami', 'wave surge', 'surge'],
    storm: ['storm', 'cyclone', 'wind'],
    waves: ['wave', 'waves', 'high waves']
  };
  const urgencyLevels = {
    urgent: ['urgent', 'immediate', 'emergency', 'help'],
    medium: ['serious', 'dangerous', 'high'],
    low: ['normal', 'minor', 'small']
  };

  const msg = (messageBody || '').toLowerCase();

  let hazardType = 'other';
  for (const [k, v] of Object.entries(hazardTypes)) {
    if (v.some(w => msg.includes(w))) { hazardType = k; break; }
  }

  let urgency = 'medium';
  for (const [k, v] of Object.entries(urgencyLevels)) {
    if (v.some(w => msg.includes(w))) { urgency = k; break; }
  }

  const locationPattern = /(?:at|in|near)\s+([^,\.\n]+)/i;
  const m = msg.match(locationPattern);
  const location = m ? m[1].trim() : 'Unknown location';

  return { hazardType, urgency, location, originalMessage: messageBody };
}

async function saveReport(report) {
  report.id = `REP${String(Date.now()).slice(-9)}`;
  report.createdAt = new Date().toISOString();
  reports.unshift(report);
  if (reports.length > 1000) reports = reports.slice(0, 1000);
  persistReports();
  return report;
}

// Updated: send confirmation via correct channel (SMS or WhatsApp)
async function sendConfirmationMessage(toNumber, report, channel) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  
  const text = `✅ Report received!\nLocation: ${report.location}\nType: ${report.hazardType}\nRef: ${report.id}\nAuthorities notified. Stay safe!\n- OceanSaksham`;
  
  try {
    let fromNumber;
    let toFormatted;
    
    if (channel === 'whatsapp') {
      fromNumber = TWILIO_WHATSAPP_FROM || 'whatsapp:+14155208886'; // Twilio sandbox default
      toFormatted = toNumber.startsWith('whatsapp:') ? toNumber : `whatsapp:${toNumber.replace('whatsapp:', '')}`;
    } else {
      fromNumber = TWILIO_PHONE_NUMBER;
      toFormatted = toNumber.replace('whatsapp:', ''); // Remove whatsapp: prefix for SMS
    }

    const msg = await twilioClient.messages.create({ 
      body: text, 
      from: fromNumber, 
      to: toFormatted 
    });
    
    console.log(`Sent ${channel} confirmation:`, msg.sid);
    return msg;
  } catch (e) {
    console.error(`${channel} send error:`, e.message);
    return null;
  }
}

// Twilio validation helper
function validateTwilioRequest(req) {
  if (!TWILIO_AUTH_TOKEN) {
    console.warn('TWILIO_AUTH_TOKEN not set — skipping Twilio validation (insecure).');
    return true;
  }

  const signature = req.headers['x-twilio-signature'] || '';
  const validationUrl = TWILIO_WEBHOOK_URL || `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  let params = {};
  if (req.rawBody && req.rawBody.length) {
    try {
      const s = req.rawBody.toString();
      params = Object.fromEntries(new URLSearchParams(s));
    } catch (e) {
      params = req.body || {};
    }
  } else {
    params = req.body || {};
  }

  const valid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, validationUrl, params);

  if (!valid) {
    console.error('Twilio validation FAILED!');
    console.error(' - X-Twilio-Signature header:', signature);
    console.error(' - Validation URL used:', validationUrl);
    console.error(' - Raw body (first 300 chars):', (req.rawBody ? req.rawBody.toString().slice(0,300) : String(req.body)).replace(/\n/g,' '));
  }

  return valid;
}

// MAIN webhook with media support
app.post('/api/twilio/incoming-sms', async (req, res) => {
  try {
    // Validate request
    const ok = validateTwilioRequest(req);
    if (!ok) {
      return res.status(403).send('Forbidden - invalid Twilio signature');
    }

    const { From, Body, MessageSid, NumMedia, MediaUrl0, MediaContentType0 } = req.body;
    const channelInfo = getChannelInfo(From);
    
    console.log(`Incoming ${channelInfo.channel} from ${From} -> ${Body || '[no text]'}`);
    if (NumMedia && parseInt(NumMedia) > 0) {
      console.log(`📎 Media attached: ${MediaContentType0} - ${MediaUrl0}`);
    }

    const parsed = parseHazardReport(Body || '');
    const coords = await geocodeLocation(parsed.location);

    // Create report object
    const reportData = {
      phoneNumber: From,
      message: Body || '[Media message]',
      hazardType: parsed.hazardType,
      location: parsed.location,
      coordinates: coords,
      urgency: parsed.urgency,
      messageSid: MessageSid,
      source: channelInfo.channel,
      status: 'pending',
      hasMedia: NumMedia && parseInt(NumMedia) > 0
    };

    // Save report first to get ID
    const report = await saveReport(reportData);

    // Download media if present
    if (NumMedia && parseInt(NumMedia) > 0 && MediaUrl0) {
      console.log(`Processing media for report ${report.id}...`);
      const mediaInfo = await downloadMedia(MediaUrl0, MediaContentType0, report.id);
      if (mediaInfo) {
        report.media = mediaInfo;
        // Update the saved report with media info
        const reportIndex = reports.findIndex(r => r.id === report.id);
        if (reportIndex !== -1) {
          reports[reportIndex] = report;
          persistReports();
        }
        console.log(`✅ Media saved for report ${report.id}: ${mediaInfo.filename}`);
      }
    }

    // Emit to dashboard
    io.emit('new-report', report);
    
    // Send confirmation via correct channel
    await sendConfirmationMessage(From, report, channelInfo.channel);

    if (parsed.urgency === 'urgent') {
      console.log('🚨 Urgent report - notify officials:', report.id);
    }

    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');
  } catch (e) {
    console.error('Webhook error:', e && e.stack ? e.stack : e);
    res.set('Content-Type', 'text/xml');
    res.status(500).send('<Response><Message>Error</Message></Response>');
  }
});

// API + dashboard
app.get('/api/reports', (req, res) => { res.json({ count: reports.length, reports }); });

app.get('/', (req, res) => {
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"/><title>OceanSaksham Dashboard</title>
<style>
body{font-family:sans-serif;margin:16px}
.report{border:1px solid #ccc;padding:10px;margin:10px 0;border-radius:8px}
.urgent{border-left:6px solid #e74c3c}
.media{margin-top:8px;padding:8px;background:#f8f9fa;border-radius:4px}
.media img{max-width:200px;height:auto;border-radius:4px}
.media video{max-width:200px;height:auto}
</style>
</head><body>
<h1>OceanSaksham Reports</h1><div id="list"></div>
<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io();
function isoToLocal(t){ return new Date(t).toLocaleString(); }
function renderMedia(r) {
  if (!r.media) return '';
  const { filename, contentType, url } = r.media;
  if (contentType.startsWith('image/')) {
    return '<div class="media"><strong>📎 Media:</strong><br><img src="'+url+'" alt="'+filename+'"></div>';
  } else if (contentType.startsWith('video/')) {
    return '<div class="media"><strong>📎 Media:</strong><br><video controls src="'+url+'"></video></div>';
  } else {
    return '<div class="media"><strong>📎 Media:</strong> <a href="'+url+'" target="_blank">'+filename+'</a></div>';
  }
}
function renderReport(r){ 
  return '<div class="report '+(r.urgency==='urgent'?'urgent':'')+'">'+
    '<div><strong>'+r.hazardType.toUpperCase()+'</strong> - '+r.location+'</div>'+
    '<div>Ref: '+r.id+' | '+isoToLocal(r.createdAt)+' | '+r.source.toUpperCase()+'</div>'+
    '<div>Coords: '+(r.coordinates? r.coordinates.lat+','+r.coordinates.lon : 'N/A')+'</div>'+
    '<div>From: '+r.phoneNumber+'</div>'+
    '<div>'+r.message+'</div>'+
    renderMedia(r)+
    '</div>'; 
}
async function load(){ 
  const res = await fetch('/api/reports'); 
  const json = await res.json(); 
  document.getElementById('list').innerHTML = json.reports.map(renderReport).join(''); 
}
load();
socket.on('new-report', r => { 
  document.getElementById('list').innerHTML = renderReport(r)+document.getElementById('list').innerHTML; 
});
</script></body></html>`);
});

server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`➡️ Webhook: POST /api/twilio/incoming-sms`);
  console.log(`📁 Media directory: ${MEDIA_DIR}`);
  if (TWILIO_WEBHOOK_URL) console.log(`➡️ Using TWILIO_WEBHOOK_URL for validation: ${TWILIO_WEBHOOK_URL}`);
});