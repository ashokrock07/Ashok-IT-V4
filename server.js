const express    = require('express');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const http       = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 3000;
const DB     = path.join(__dirname, 'data', 'db.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const rdb = ()  => JSON.parse(fs.readFileSync(DB, 'utf8'));
const wdb = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));

/* ──────────────────────────────────────────────
   WHATSAPP — whatsapp-web.js real integration
────────────────────────────────────────────── */
let waStatus = 'disconnected';
let waPhone  = null;
let waClient = null;
let waQR     = null;

async function initWhatsApp() {
  try {
    const { Client, LocalAuth } = require('whatsapp-web.js');

    waClient = new Client({
      authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ]
      }
    });

    waClient.on('qr', (qr) => {
      waQR    = qr;
      waStatus = 'qr';
      console.log('WhatsApp QR generated');
      io.emit('wa:status', { status: 'qr', phone: null, qr });
    });

    waClient.on('ready', () => {
      waStatus = 'ready';
      waQR     = null;
      waPhone  = waClient.info?.wid?.user || 'connected';
      console.log('WhatsApp ready! Phone:', waPhone);
      io.emit('wa:status', { status: 'ready', phone: waPhone, qr: null });
    });

    waClient.on('authenticated', () => {
      waStatus = 'connecting';
      io.emit('wa:status', { status: 'connecting', phone: null, qr: null });
    });

    waClient.on('auth_failure', () => {
      waStatus = 'error';
      io.emit('wa:status', { status: 'error', phone: null, qr: null });
    });

    waClient.on('disconnected', () => {
      waStatus = 'disconnected';
      waPhone  = null;
      waQR     = null;
      io.emit('wa:status', { status: 'disconnected', phone: null, qr: null });
    });

    // Incoming message — auto bot reply
    waClient.on('message', async (msg) => {
      if (msg.fromMe) return;
      const phone = msg.from.replace('@c.us', '').replace(/\D/g, '').slice(-10);
      const reply = buildBotReply(msg.body, phone);

      try { await msg.reply(reply); } catch(e) { console.error('Reply error:', e.message); }

      const db = rdb();
      const log = {
        id: Date.now(),
        student: resolveNameFromPhone(db, phone),
        phone,
        type: 'bot_reply',
        message: msg.body.substring(0, 60) + ' → ' + reply.substring(0, 60),
        time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        status: 'sent'
      };
      db.whatsapp_logs.push(log);
      wdb(db);
      io.emit('wa:message', log);
    });

    await waClient.initialize();
    console.log('WhatsApp client initializing...');

  } catch (err) {
    console.log('whatsapp-web.js not available — running in simulator mode');
    waStatus = 'simulator';
  }
}

// Start WhatsApp on boot
initWhatsApp();

/* ── WA API routes ── */
app.get('/api/wa/status', (req, res) => {
  res.json({ status: waStatus, phone: waPhone, qr: waQR });
});

app.post('/api/wa/connect', async (req, res) => {
  if (waStatus === 'ready') return res.json({ ok: true, status: 'ready', phone: waPhone });
  if (waStatus === 'qr')    return res.json({ ok: true, status: 'qr', qr: waQR });
  if (waStatus === 'simulator') return res.json({ ok: false, message: 'Running in simulator mode — whatsapp-web.js not installed.' });
  // If disconnected, try re-init
  try { await initWhatsApp(); } catch(e) {}
  res.json({ ok: true, status: waStatus, qr: waQR });
});

app.post('/api/wa/disconnect', async (req, res) => {
  try {
    if (waClient) await waClient.destroy();
  } catch(e) {}
  waClient = null; waStatus = 'disconnected'; waPhone = null; waQR = null;
  io.emit('wa:status', { status: 'disconnected', phone: null, qr: null });
  res.json({ ok: true });
});

app.post('/api/wa/send', async (req, res) => {
  const { phone, message } = req.body;
  if (waStatus !== 'ready' || !waClient) {
    return res.json({ ok: false, reason: 'WhatsApp not connected' });
  }
  try {
    const chatId = `91${phone}@c.us`;
    await waClient.sendMessage(chatId, message);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, reason: e.message });
  }
});

/* ──────────────────────────────────────────────
   BOT REPLY LOGIC
────────────────────────────────────────────── */
function resolveNameFromPhone(db, phone) {
  const s = db.students.find(s => s.phone === phone);
  if (s) return s.name;
  const e = db.enquiries.find(e => e.phone === phone);
  if (e) return e.name;
  return 'Visitor';
}

function buildBotReply(message, phone) {
  const db      = rdb();
  const msg     = (message || '').toLowerCase().trim();
  const student = db.students.find(s => s.phone === phone);

  if (['hi','hello','hey','start','hii','helo'].includes(msg))
    return `Welcome to Ashok IT! 👋\n\nHow can we help you today?\n\n1️⃣ Course Details\n2️⃣ Fee Enquiry\n3️⃣ Book Demo Class\n4️⃣ Batch Timings\n5️⃣ Placement Info\n\nReply with a number.`;

  if (msg === '1' || msg.includes('course') || msg.includes('courses'))
    return `📚 *Ashok IT Courses:*\n\nJava Full Stack — Rs 38,000 (3 months)\nPython Full Stack — Rs 35,000 (3 months)\nData Science — Rs 42,000 (4 months)\nMERN Stack — Rs 38,000 (3 months)\nAWS DevOps — Rs 40,000 (3 months)\nMachine Learning — Rs 45,000 (4 months)\nSAP FICO — Rs 44,000 (3 months)\n\nReply *DEMO* to book a free demo class.`;

  if (msg === '2' || msg.includes('fee') || msg.includes('due') || msg.includes('payment') || msg.includes('fees')) {
    if (student && student.fee_due > 0)
      return `💰 *Fee Details — ${student.name}*\n\nCourse: ${student.course}\nTotal Fee: Rs ${student.fee_total.toLocaleString()}\nAmount Paid: Rs ${student.fee_paid.toLocaleString()}\n*Amount Due: Rs ${student.fee_due.toLocaleString()}*\nDue Date: ${student.due_date || 'Contact office'}\n\nPay via GPay / PhonePe to:\n📞 Contact: 040-XXXXXXX`;
    if (student)
      return `✅ Hello ${student.name}! Your fee is fully paid!\n\nCourse: ${student.course}\nProgress: ${student.progress || 0}%\n\nKeep it up! 💪`;
    return `Please contact us for fee details.\n📞 Call: 040-XXXXXXX\n🕐 Hours: 9am–7pm (Mon–Sat)`;
  }

  if (msg === '3' || msg === 'demo' || msg.includes('demo'))
    return `🎓 *Free Demo Class Slots:*\n\nJava Full Stack — Dec 20, 10:00 AM\nPython Full Stack — Dec 21, 11:00 AM\nData Science — Dec 22, 10:00 AM\nAWS DevOps — Dec 23, 3:00 PM\n\nReply with your *name* and *preferred course* to confirm your seat!`;

  if (msg === '4' || msg.includes('batch') || msg.includes('timing') || msg.includes('schedule') || msg.includes('time'))
    return `🕐 *Batch Timings — Ashok IT:*\n\nMorning Batch: 9:00 AM – 12:00 PM\nEvening Batch: 6:00 PM – 9:00 PM\nWeekend Batch: 9:00 AM – 1:00 PM\n\n📅 Next batch: Jan 6\n📞 Call 040-XXXXXXX for seat availability.`;

  if (msg === '5' || msg.includes('placement') || msg.includes('job') || msg.includes('salary') || msg.includes('package'))
    return `🏆 *Ashok IT Placement 2024:*\n\nPlacement Rate: *91%*\nAverage Package: *Rs 4.8 LPA*\nHighest Package: *Rs 9.2 LPA*\n\n🏢 Hiring Partners:\nTCS, Infosys, Wipro, Accenture,\nHCL, Capgemini, Tech Mahindra\n\nVisit us for the full placement report!`;

  if (msg.includes('address') || msg.includes('location') || msg.includes('where'))
    return `📍 *Ashok IT — Ameerpet, Hyderabad*\n\nNear Ashok Nagar Metro Station\nOpp. Syndicate Bank\nHyderabad — 500016\n\n🕐 Open: 9am–7pm (Mon–Sat)\n📞 040-XXXXXXX`;

  if (msg.includes('contact') || msg.includes('call') || msg.includes('phone') || msg.includes('number'))
    return `📞 *Contact Ashok IT:*\n\nPhone: 040-XXXXXXX\nWhatsApp: This number\nEmail: info@ashok-it.in\n\n🕐 Hours: 9am–7pm (Mon–Sat)\n📍 Ameerpet, Hyderabad`;

  return `Thank you for reaching out to *Ashok IT*! 🙏\n\nOur team will respond shortly.\n\n📞 Call: 040-XXXXXXX\n🕐 9am–7pm (Mon–Sat)\n\nQuick options:\n1️⃣ Courses  2️⃣ Fee  3️⃣ Demo  4️⃣ Timings  5️⃣ Placement`;
}

/* ──────────────────────────────────────────────
   DASHBOARD
────────────────────────────────────────────── */
app.get('/api/dashboard', (req, res) => {
  const db  = rdb();
  const def = db.students.filter(s => s.fee_due > 0);
  res.json({
    totalStudents:    db.students.length,
    feeCollected:     db.students.reduce((a, s) => a + s.fee_paid, 0),
    feeOutstanding:   def.reduce((a, s) => a + s.fee_due, 0),
    defaultersCount:  def.length,
    activeBatches:    db.batches.filter(b => b.status === 'ongoing').length,
    totalEnquiries:   db.enquiries.length,
    pendingFollowups: db.enquiries.filter(e => e.status === 'followup').length,
    waMsgsSent:       db.whatsapp_logs.length,
    waStatus
  });
});

/* ──────────────────────────────────────────────
   STUDENTS
────────────────────────────────────────────── */
app.get('/api/students', (req, res) => {
  const db = rdb();
  res.json(db.students.slice().sort((a, b) => b.created_at - a.created_at));
});
app.post('/api/students', (req, res) => {
  const db = rdb(), now = Date.now();
  const { fee_total = 0, fee_paid = 0 } = req.body;
  const fee_due = Math.max(0, fee_total - fee_paid);
  const status  = fee_paid >= fee_total ? 'paid' : fee_paid > 0 ? 'partial' : 'overdue';
  const s = { id: now, created_at: now, ...req.body, fee_due, status };
  db.students.push(s); wdb(db); res.json({ success: true, student: s });
});
app.put('/api/students/:id', (req, res) => {
  const db  = rdb();
  const idx = db.students.findIndex(s => s.id == req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const u = { ...db.students[idx], ...req.body, updated_at: Date.now() };
  u.fee_due = Math.max(0, u.fee_total - u.fee_paid);
  u.status  = u.fee_paid >= u.fee_total ? 'paid' : u.fee_paid > 0 ? 'partial' : 'overdue';
  db.students[idx] = u; wdb(db); res.json({ success: true, student: u });
});
app.delete('/api/students/:id', (req, res) => {
  const db = rdb();
  db.students = db.students.filter(s => s.id != req.params.id);
  wdb(db); res.json({ success: true });
});

/* ──────────────────────────────────────────────
   FEES
────────────────────────────────────────────── */
app.get('/api/fees/defaulters', (req, res) => {
  const db = rdb();
  res.json(db.students.filter(s => s.fee_due > 0).sort((a, b) => b.fee_due - a.fee_due));
});
app.post('/api/fees/remind/:id', async (req, res) => {
  const db = rdb(), s = db.students.find(s => s.id == req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const message = `💰 *Fee Reminder — Ashok IT*\n\nHello ${s.name},\n\nYour fee payment is pending:\nCourse: ${s.course}\nAmount Due: *Rs ${s.fee_due.toLocaleString()}*\nDue Date: ${s.due_date || 'Immediate'}\n\nPlease pay via GPay/PhonePe.\n📞 040-XXXXXXX`;
  let waSent = false;
  if (waStatus === 'ready' && waClient) {
    try {
      await waClient.sendMessage(`91${s.phone}@c.us`, message);
      waSent = true;
    } catch(e) { console.error('Send error:', e.message); }
  }
  const log = {
    id: Date.now(), student: s.name, phone: s.phone,
    type: 'fee_reminder',
    message: `Fee reminder: Rs ${s.fee_due.toLocaleString()} due`,
    time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    status: waSent ? 'sent' : 'simulated'
  };
  db.whatsapp_logs.push(log); wdb(db);
  io.emit('wa:message', log);
  res.json({ success: true, log, waSent });
});
app.post('/api/fees/remind-all', async (req, res) => {
  const db  = rdb();
  const def = db.students.filter(s => s.fee_due > 0);
  let sentCount = 0;
  const logs = [];
  for (const s of def) {
    const message = `💰 *Fee Reminder — Ashok IT*\n\nHello ${s.name},\n\nAmount Due: *Rs ${s.fee_due.toLocaleString()}*\nCourse: ${s.course}\nDue Date: ${s.due_date || 'Immediate'}\n\nPlease pay at the earliest.\n📞 040-XXXXXXX`;
    let waSent = false;
    if (waStatus === 'ready' && waClient) {
      try { await waClient.sendMessage(`91${s.phone}@c.us`, message); waSent = true; sentCount++; } catch(e) {}
    }
    logs.push({
      id: Date.now() + Math.random(), student: s.name, phone: s.phone,
      type: 'fee_reminder',
      message: `Reminder: Rs ${s.fee_due.toLocaleString()} due`,
      time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      status: waSent ? 'sent' : 'simulated'
    });
  }
  db.whatsapp_logs.push(...logs); wdb(db);
  io.emit('wa:bulk', { count: def.length, sent: sentCount });
  res.json({ success: true, count: def.length, waSent: sentCount });
});

/* ──────────────────────────────────────────────
   ENQUIRIES
────────────────────────────────────────────── */
app.get('/api/enquiries', (req, res) => {
  const db = rdb();
  res.json(db.enquiries.slice().sort((a, b) => b.created_at - a.created_at));
});
app.post('/api/enquiries', async (req, res) => {
  const db = rdb(), now = Date.now();
  const e = { id: now, created_at: now, date: new Date().toISOString().split('T')[0], status: 'followup', ...req.body };
  db.enquiries.push(e);
  // Auto WhatsApp reply to new enquiry
  const autoMsg = `👋 *Welcome to Ashok IT!*\n\nHello ${e.name}, thank you for your interest in *${e.course}*!\n\nOur counselor will contact you shortly.\n\nMeanwhile, reply with:\n1️⃣ Course Details\n2️⃣ Fee Info\n3️⃣ Book Demo Class\n\n📞 040-XXXXXXX`;
  let waSent = false;
  if (waStatus === 'ready' && waClient) {
    try { await waClient.sendMessage(`91${e.phone}@c.us`, autoMsg); waSent = true; } catch(err) {}
  }
  db.whatsapp_logs.push({
    id: now + 1, student: e.name, phone: e.phone,
    type: 'enquiry_reply',
    message: `Auto-reply sent: ${e.course} enquiry`,
    time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    status: waSent ? 'sent' : 'simulated'
  });
  wdb(db); res.json({ success: true, enquiry: e, waSent });
});
app.put('/api/enquiries/:id', (req, res) => {
  const db  = rdb();
  const idx = db.enquiries.findIndex(e => e.id == req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  db.enquiries[idx] = { ...db.enquiries[idx], ...req.body, updated_at: Date.now() };
  wdb(db); res.json({ success: true, enquiry: db.enquiries[idx] });
});
app.delete('/api/enquiries/:id', (req, res) => {
  const db = rdb();
  db.enquiries = db.enquiries.filter(e => e.id != req.params.id);
  wdb(db); res.json({ success: true });
});

/* ──────────────────────────────────────────────
   BATCHES
────────────────────────────────────────────── */
app.get('/api/batches', (req, res) => {
  const db = rdb();
  res.json(db.batches.slice().sort((a, b) => b.created_at - a.created_at));
});
app.post('/api/batches', (req, res) => {
  const db = rdb(), now = Date.now();
  const b = { id: now, created_at: now, students: 0, progress: 0, status: 'starting_soon', ...req.body };
  db.batches.push(b); wdb(db); res.json({ success: true, batch: b });
});
app.put('/api/batches/:id', (req, res) => {
  const db  = rdb();
  const idx = db.batches.findIndex(b => b.id == req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  db.batches[idx] = { ...db.batches[idx], ...req.body };
  wdb(db); res.json({ success: true, batch: db.batches[idx] });
});
app.delete('/api/batches/:id', (req, res) => {
  const db = rdb();
  db.batches = db.batches.filter(b => b.id != req.params.id);
  wdb(db); res.json({ success: true });
});

/* ──────────────────────────────────────────────
   STAFF
────────────────────────────────────────────── */
app.get('/api/staff', (req, res) => {
  const db = rdb();
  res.json(db.staff.slice().sort((a, b) => b.created_at - a.created_at));
});
app.post('/api/staff', (req, res) => {
  const db = rdb(), now = Date.now();
  const m = { id: now, created_at: now, status: 'active', batches: 0, ...req.body };
  db.staff.push(m); wdb(db); res.json({ success: true, member: m });
});
app.put('/api/staff/:id', (req, res) => {
  const db  = rdb();
  const idx = db.staff.findIndex(s => s.id == req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  db.staff[idx] = { ...db.staff[idx], ...req.body };
  wdb(db); res.json({ success: true, member: db.staff[idx] });
});
app.delete('/api/staff/:id', (req, res) => {
  const db = rdb();
  db.staff = db.staff.filter(s => s.id != req.params.id);
  wdb(db); res.json({ success: true });
});

/* ──────────────────────────────────────────────
   WHATSAPP LOGS + BOT SIMULATOR
────────────────────────────────────────────── */
app.get('/api/whatsapp/logs', (req, res) => {
  const db = rdb();
  res.json(db.whatsapp_logs.slice().reverse().slice(0, 50));
});
app.post('/api/whatsapp/bot', (req, res) => {
  const { message = '', phone = '' } = req.body;
  const reply = buildBotReply(message, phone);
  const db    = rdb();
  db.whatsapp_logs.push({
    id: Date.now(), student: resolveNameFromPhone(db, phone), phone,
    type: 'bot_reply',
    message: `${message.substring(0,40)} → ${reply.substring(0,40)}`,
    time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    status: 'simulated'
  });
  wdb(db); res.json({ success: true, reply });
});

/* ──────────────────────────────────────────────
   SOCKET + SERVE
────────────────────────────────────────────── */
io.on('connection', (socket) => {
  socket.emit('wa:status', { status: waStatus, phone: waPhone, qr: waQR });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => {
  console.log(`Ashok IT running on port ${PORT}`);
});
