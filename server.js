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
   WHATSAPP — Baileys (no Chromium needed!)
────────────────────────────────────────────── */
let waStatus = 'disconnected';
let waPhone  = null;
let waSock   = null;
let waQR     = null;

async function initWhatsApp() {
  try {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion
    } = require('@whiskeysockets/baileys');
    const { Boom } = require('@hapi/boom');
    const P = require('pino');

    const authDir = path.join(__dirname, '.wa_auth');
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    waSock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: P({ level: 'silent' }),
      browser: ['Ashok IT Bot', 'Chrome', '1.0.0'],
      generateHighQualityLinkPreview: false,
    });

    waSock.ev.on('creds.update', saveCreds);

    waSock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Convert QR to string for frontend
        const QRCode = require('qrcode');
        const qrDataUrl = await QRCode.toDataURL(qr);
        waQR    = qrDataUrl;
        waStatus = 'qr';
        console.log('QR generated — scan with WhatsApp!');
        io.emit('wa:status', { status: 'qr', phone: null, qr: qrDataUrl });
      }

      if (connection === 'open') {
        waStatus = 'ready';
        waQR     = null;
        waPhone  = waSock.user?.id?.split(':')[0] || 'connected';
        console.log('WhatsApp connected! Phone:', waPhone);
        io.emit('wa:status', { status: 'ready', phone: waPhone, qr: null });
      }

      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log('WA disconnected, code:', code, 'reconnect:', shouldReconnect);
        waStatus = 'disconnected';
        waPhone  = null;
        waQR     = null;
        io.emit('wa:status', { status: 'disconnected', phone: null, qr: null });
        if (shouldReconnect) {
          console.log('Reconnecting in 5s...');
          setTimeout(initWhatsApp, 5000);
        }
      }
    });

    // Incoming messages — auto bot reply
    waSock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const body = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || '';
        if (!body) continue;

        const jid   = msg.key.remoteJid;
        const phone = jid.replace('@s.whatsapp.net', '').replace(/\D/g,'').slice(-10);
        const reply = buildBotReply(body, phone);

        try {
          await waSock.sendMessage(jid, { text: reply });
        } catch(e) {
          console.error('Send error:', e.message);
        }

        const db = rdb();
        const log = {
          id: Date.now(),
          student: resolveNameFromPhone(db, phone),
          phone,
          type: 'bot_reply',
          message: `${body.substring(0,40)} → ${reply.substring(0,40)}`,
          time: new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }),
          status: 'sent'
        };
        db.whatsapp_logs.push(log);
        wdb(db);
        io.emit('wa:message', log);
      }
    });

  } catch (err) {
    console.log('Baileys not available — simulator mode. Error:', err.message);
    waStatus = 'simulator';
  }
}

initWhatsApp();

/* ── WA API Routes ── */
app.get('/api/wa/status', (req, res) => {
  res.json({ status: waStatus, phone: waPhone, qr: waQR });
});

app.post('/api/wa/connect', (req, res) => {
  if (waStatus === 'ready')     return res.json({ ok: true, status: 'ready', phone: waPhone });
  if (waStatus === 'qr')        return res.json({ ok: true, status: 'qr', qr: waQR });
  if (waStatus === 'simulator') return res.json({ ok: false, message: 'Bot simulator mode — install dependencies.' });
  res.json({ ok: true, status: waStatus, qr: waQR });
});

app.post('/api/wa/disconnect', async (req, res) => {
  try {
    if (waSock) await waSock.logout();
  } catch(e) {}
  // Clear auth so next connect shows fresh QR
  const authDir = path.join(__dirname, '.wa_auth');
  try { fs.rmSync(authDir, { recursive: true }); } catch(e) {}
  waSock = null; waStatus = 'disconnected'; waPhone = null; waQR = null;
  io.emit('wa:status', { status: 'disconnected', phone: null, qr: null });
  res.json({ ok: true });
});

app.post('/api/wa/send', async (req, res) => {
  const { phone, message } = req.body;
  if (waStatus !== 'ready' || !waSock)
    return res.json({ ok: false, reason: 'WhatsApp not connected' });
  try {
    await waSock.sendMessage(`91${phone}@s.whatsapp.net`, { text: message });
    res.json({ ok: true });
  } catch(e) {
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

  if (msg === '1' || msg.includes('course'))
    return `📚 *Ashok IT Courses:*\n\nJava Full Stack — Rs 38,000 (3 months)\nPython Full Stack — Rs 35,000 (3 months)\nData Science — Rs 42,000 (4 months)\nMERN Stack — Rs 38,000 (3 months)\nAWS DevOps — Rs 40,000 (3 months)\nMachine Learning — Rs 45,000 (4 months)\nSAP FICO — Rs 44,000 (3 months)\n\nReply *DEMO* to book a free demo class.`;

  if (msg === '2' || msg.includes('fee') || msg.includes('due') || msg.includes('payment')) {
    if (student && student.fee_due > 0)
      return `💰 *Fee Details — ${student.name}*\n\nCourse: ${student.course}\nTotal: Rs ${student.fee_total.toLocaleString()}\nPaid: Rs ${student.fee_paid.toLocaleString()}\n*Due: Rs ${student.fee_due.toLocaleString()}*\nDue Date: ${student.due_date || 'Contact office'}\n\nPay via GPay/PhonePe\n📞 040-XXXXXXX`;
    if (student)
      return `✅ Hello ${student.name}! Fee fully paid!\n\nCourse: ${student.course}\nProgress: ${student.progress || 0}%\n\nKeep it up! 💪`;
    return `Please contact us for fee details.\n📞 040-XXXXXXX\n🕐 9am–7pm (Mon–Sat)`;
  }

  if (msg === '3' || msg === 'demo' || msg.includes('demo'))
    return `🎓 *Free Demo Class Slots:*\n\nJava Full Stack — Dec 20, 10:00 AM\nPython Full Stack — Dec 21, 11:00 AM\nData Science — Dec 22, 10:00 AM\nAWS DevOps — Dec 23, 3:00 PM\n\nReply with your *name* and *preferred course* to confirm!`;

  if (msg === '4' || msg.includes('batch') || msg.includes('timing') || msg.includes('schedule'))
    return `🕐 *Batch Timings — Ashok IT:*\n\nMorning: 9:00 AM – 12:00 PM\nEvening: 6:00 PM – 9:00 PM\nWeekend: 9:00 AM – 1:00 PM\n\n📅 Next batch: Jan 6\n📞 040-XXXXXXX`;

  if (msg === '5' || msg.includes('placement') || msg.includes('job') || msg.includes('salary'))
    return `🏆 *Ashok IT Placement 2024:*\n\nRate: *91%*\nAverage: *Rs 4.8 LPA*\nHighest: *Rs 9.2 LPA*\n\n🏢 TCS, Infosys, Wipro, Accenture, HCL, Capgemini, Tech Mahindra`;

  if (msg.includes('address') || msg.includes('location') || msg.includes('where'))
    return `📍 *Ashok IT — Ameerpet, Hyderabad*\n\nNear Ashok Nagar Metro Station\nHyderabad — 500016\n\n🕐 9am–7pm (Mon–Sat)\n📞 040-XXXXXXX`;

  return `Thank you for reaching out to *Ashok IT*! 🙏\n\n📞 040-XXXXXXX\n🕐 9am–7pm (Mon–Sat)\n\n1️⃣ Courses  2️⃣ Fee  3️⃣ Demo  4️⃣ Timings  5️⃣ Placement`;
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

/* ── STUDENTS ── */
app.get('/api/students', (req, res) => { const db=rdb(); res.json(db.students.slice().sort((a,b)=>b.created_at-a.created_at)); });
app.post('/api/students', (req, res) => {
  const db=rdb(), now=Date.now();
  const {fee_total=0,fee_paid=0}=req.body;
  const fee_due=Math.max(0,fee_total-fee_paid);
  const status=fee_paid>=fee_total?'paid':fee_paid>0?'partial':'overdue';
  const s={id:now,created_at:now,...req.body,fee_due,status};
  db.students.push(s); wdb(db); res.json({success:true,student:s});
});
app.put('/api/students/:id', (req, res) => {
  const db=rdb(); const idx=db.students.findIndex(s=>s.id==req.params.id);
  if(idx<0) return res.status(404).json({error:'Not found'});
  const u={...db.students[idx],...req.body,updated_at:Date.now()};
  u.fee_due=Math.max(0,u.fee_total-u.fee_paid);
  u.status=u.fee_paid>=u.fee_total?'paid':u.fee_paid>0?'partial':'overdue';
  db.students[idx]=u; wdb(db); res.json({success:true,student:u});
});
app.delete('/api/students/:id', (req, res) => {
  const db=rdb(); db.students=db.students.filter(s=>s.id!=req.params.id); wdb(db); res.json({success:true});
});

/* ── FEES ── */
app.get('/api/fees/defaulters', (req, res) => {
  const db=rdb(); res.json(db.students.filter(s=>s.fee_due>0).sort((a,b)=>b.fee_due-a.fee_due));
});
app.post('/api/fees/remind/:id', async (req, res) => {
  const db=rdb(), s=db.students.find(s=>s.id==req.params.id);
  if(!s) return res.status(404).json({error:'Not found'});
  const message=`💰 *Fee Reminder — Ashok IT*\n\nHello ${s.name},\n\nAmount Due: *Rs ${s.fee_due.toLocaleString()}*\nCourse: ${s.course}\nDue Date: ${s.due_date||'Immediate'}\n\nPlease pay via GPay/PhonePe.\n📞 040-XXXXXXX`;
  let waSent=false;
  if(waStatus==='ready'&&waSock){
    try { await waSock.sendMessage(`91${s.phone}@s.whatsapp.net`,{text:message}); waSent=true; } catch(e){}
  }
  const log={id:Date.now(),student:s.name,phone:s.phone,type:'fee_reminder',
    message:`Reminder: Rs ${s.fee_due.toLocaleString()} due`,
    time:new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}),
    status:waSent?'sent':'simulated'};
  db.whatsapp_logs.push(log); wdb(db);
  io.emit('wa:message',log);
  res.json({success:true,log,waSent});
});
app.post('/api/fees/remind-all', async (req, res) => {
  const db=rdb(); const def=db.students.filter(s=>s.fee_due>0);
  let sentCount=0; const logs=[];
  for(const s of def){
    const message=`💰 *Fee Reminder — Ashok IT*\n\nHello ${s.name},\n\nDue: *Rs ${s.fee_due.toLocaleString()}*\nCourse: ${s.course}\n\n📞 040-XXXXXXX`;
    let waSent=false;
    if(waStatus==='ready'&&waSock){
      try { await waSock.sendMessage(`91${s.phone}@s.whatsapp.net`,{text:message}); waSent=true; sentCount++; } catch(e){}
    }
    logs.push({id:Date.now()+Math.random(),student:s.name,phone:s.phone,type:'fee_reminder',
      message:`Reminder: Rs ${s.fee_due.toLocaleString()} due`,
      time:new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}),
      status:waSent?'sent':'simulated'});
  }
  db.whatsapp_logs.push(...logs); wdb(db);
  io.emit('wa:bulk',{count:def.length,sent:sentCount});
  res.json({success:true,count:def.length,waSent:sentCount});
});

/* ── ENQUIRIES ── */
app.get('/api/enquiries', (req, res) => { const db=rdb(); res.json(db.enquiries.slice().sort((a,b)=>b.created_at-a.created_at)); });
app.post('/api/enquiries', async (req, res) => {
  const db=rdb(), now=Date.now();
  const e={id:now,created_at:now,date:new Date().toISOString().split('T')[0],status:'followup',...req.body};
  db.enquiries.push(e);
  const autoMsg=`👋 *Welcome to Ashok IT!*\n\nHello ${e.name}, thank you for your interest in *${e.course}*!\n\nOur counselor will contact you shortly.\n\n1️⃣ Course Details  2️⃣ Fee Info  3️⃣ Book Demo\n\n📞 040-XXXXXXX`;
  let waSent=false;
  if(waStatus==='ready'&&waSock){
    try { await waSock.sendMessage(`91${e.phone}@s.whatsapp.net`,{text:autoMsg}); waSent=true; } catch(err){}
  }
  db.whatsapp_logs.push({id:now+1,student:e.name,phone:e.phone,type:'enquiry_reply',
    message:`Auto-reply: ${e.course} enquiry`,
    time:new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}),
    status:waSent?'sent':'simulated'});
  wdb(db); res.json({success:true,enquiry:e,waSent});
});
app.put('/api/enquiries/:id', (req, res) => {
  const db=rdb(); const idx=db.enquiries.findIndex(e=>e.id==req.params.id);
  if(idx<0) return res.status(404).json({error:'Not found'});
  db.enquiries[idx]={...db.enquiries[idx],...req.body,updated_at:Date.now()};
  wdb(db); res.json({success:true,enquiry:db.enquiries[idx]});
});
app.delete('/api/enquiries/:id', (req, res) => {
  const db=rdb(); db.enquiries=db.enquiries.filter(e=>e.id!=req.params.id); wdb(db); res.json({success:true});
});

/* ── BATCHES ── */
app.get('/api/batches', (req, res) => { const db=rdb(); res.json(db.batches.slice().sort((a,b)=>b.created_at-a.created_at)); });
app.post('/api/batches', (req, res) => {
  const db=rdb(), now=Date.now();
  const b={id:now,created_at:now,students:0,progress:0,status:'starting_soon',...req.body};
  db.batches.push(b); wdb(db); res.json({success:true,batch:b});
});
app.put('/api/batches/:id', (req, res) => {
  const db=rdb(); const idx=db.batches.findIndex(b=>b.id==req.params.id);
  if(idx<0) return res.status(404).json({error:'Not found'});
  db.batches[idx]={...db.batches[idx],...req.body}; wdb(db); res.json({success:true,batch:db.batches[idx]});
});
app.delete('/api/batches/:id', (req, res) => {
  const db=rdb(); db.batches=db.batches.filter(b=>b.id!=req.params.id); wdb(db); res.json({success:true});
});

/* ── STAFF ── */
app.get('/api/staff', (req, res) => { const db=rdb(); res.json(db.staff.slice().sort((a,b)=>b.created_at-a.created_at)); });
app.post('/api/staff', (req, res) => {
  const db=rdb(), now=Date.now();
  const m={id:now,created_at:now,status:'active',batches:0,...req.body};
  db.staff.push(m); wdb(db); res.json({success:true,member:m});
});
app.put('/api/staff/:id', (req, res) => {
  const db=rdb(); const idx=db.staff.findIndex(s=>s.id==req.params.id);
  if(idx<0) return res.status(404).json({error:'Not found'});
  db.staff[idx]={...db.staff[idx],...req.body}; wdb(db); res.json({success:true,member:db.staff[idx]});
});
app.delete('/api/staff/:id', (req, res) => {
  const db=rdb(); db.staff=db.staff.filter(s=>s.id!=req.params.id); wdb(db); res.json({success:true});
});

/* ── WA LOGS + SIMULATOR ── */
app.get('/api/whatsapp/logs', (req, res) => {
  const db=rdb(); res.json(db.whatsapp_logs.slice().reverse().slice(0,50));
});
app.post('/api/whatsapp/bot', (req, res) => {
  const {message='',phone=''}=req.body;
  const reply=buildBotReply(message,phone);
  const db=rdb();
  db.whatsapp_logs.push({id:Date.now(),student:resolveNameFromPhone(db,phone),phone,
    type:'bot_reply',message:`${message.substring(0,40)} → ${reply.substring(0,40)}`,
    time:new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}),status:'simulated'});
  wdb(db); res.json({success:true,reply});
});

/* ── SOCKET + SERVE ── */
io.on('connection', (socket) => {
  socket.emit('wa:status', { status: waStatus, phone: waPhone, qr: waQR });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => console.log(`Ashok IT running on port ${PORT}`));
