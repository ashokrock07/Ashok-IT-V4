# Ashok IT — Coaching Center Management System

A complete coaching center management system with real WhatsApp two-way integration.

## Features
- Dashboard with live stats
- Real WhatsApp Bot (two-way messaging via whatsapp-web.js)
- Fee Management with bulk reminders sent directly to WhatsApp
- Enquiry Tracker with auto WhatsApp reply on add
- Student, Batch, and Staff management (Add / Edit / Delete)
- Light / Dark mode toggle
- Settings panel
- Live clock and bot status in topbar

## Quick Start

### 1. Install Node.js
Download from https://nodejs.org (LTS version)

### 2. Setup project
```bash
unzip ashok-it-whatsapp.zip
cd ashok-it
npm install
```

### 3. Start the server
```bash
node server.js
```

### 4. Open the app
Go to http://localhost:3000 in your browser

### 5. Connect WhatsApp
- Click "WhatsApp Bot" in the sidebar
- Click "Connect WhatsApp"
- Scan the QR code with your phone:
  WhatsApp → 3 dots → Linked Devices → Link a Device → Scan QR

### 6. Done!
Once connected, the bot handles all incoming messages automatically.
Fee reminders go directly to students' WhatsApp.

## Keep it Running (Windows)
Install pm2 to keep the server alive even when you minimize the terminal:
```bash
npm install -g pm2
pm2 start server.js --name "ashok-it"
pm2 save
pm2 startup
```

## API Routes
- GET/POST /api/students
- PUT/DELETE /api/students/:id
- GET/POST /api/enquiries
- PUT/DELETE /api/enquiries/:id
- GET/POST /api/batches
- PUT/DELETE /api/batches/:id
- GET/POST /api/staff
- PUT/DELETE /api/staff/:id
- GET /api/fees/defaulters
- POST /api/fees/remind/:id
- POST /api/fees/remind-all
- GET /api/whatsapp/logs
- POST /api/whatsapp/bot
- GET /api/wa/status
- POST /api/wa/connect
- POST /api/wa/disconnect
- POST /api/wa/send
- GET /api/dashboard
