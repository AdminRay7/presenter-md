import dns from 'dns';
dns.setServers(['8.8.8.8', '8.8.4.4']); 

import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import chalk from 'chalk';
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import { connectDB } from './database/models.js';
import { presenter } from './presenter.js';
import { config } from './config.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 1. WEB DASHBOARD ──
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 5000; 

let sock;
let isPairing = false;
let isSocketReady = false; // Track if Baileys is ready to accept a pairing request

// ── 2. CONNECT DATABASE ──
connectDB(config.mongoURI);

// ── 3. START WHATSAPP BOT ──
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        logger: pino({ level: "silent" }),
        auth: state,
        // FIX 1: Use Baileys standard browser to prevent ghost codes
        browser: Browsers.macOS("Desktop") 
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // FIX 2: The socket is only ready for pairing once the QR event fires
        if (qr) {
            isSocketReady = true;
            console.log(chalk.cyan('[+] Socket ready for web pairing.'));
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect && !isPairing) {
                isSocketReady = false;
                startBot();
            }
        } else if (connection === 'open') {
            console.log(chalk.green(`\n[+] ${config.botName} Connected Successfully!`));
            isPairing = false;
            isSocketReady = false;
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        await presenter(sock, m, config);
    });
}

// ── 4. WEB PAIRING API ROUTE ──
app.post('/pair', async (req, res) => {
    try {
        const { phone } = req.body;
        
        if (!phone) {
            return res.status(400).json({ error: "Phone number is required." });
        }

        if (sock.authState.creds.registered) {
            return res.status(400).json({ error: "Bot is already linked to a WhatsApp account." });
        }

        if (!isSocketReady) {
            return res.status(400).json({ error: "Socket is still connecting. Please wait 5 seconds and try again." });
        }

        // FIX 3: Strip out spaces, plus signs, and dashes
        const cleanPhone = phone.replace(/\D/g, '');
        
        isPairing = true;
        
        // Request the code
        const code = await sock.requestPairingCode(cleanPhone);
        
        console.log(chalk.cyan(`[+] Pairing code generated for ${cleanPhone}: ${code}`));
        
        res.json({ code: code });

    } catch (error) {
        console.error("Pairing error:", error);
        isPairing = false;
        res.status(500).json({ error: error.message });
    }
});

// ── 5. LAUNCH ──
app.listen(PORT, '0.0.0.0', () => {
    console.log(chalk.cyan(`[+] Web Dashboard running on port ${PORT}`));
    startBot(); 
});