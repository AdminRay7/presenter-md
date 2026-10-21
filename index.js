import dns from 'dns';
dns.setServers(['8.8.8.8', '8.8.4.4']); 

import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
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
app.use(express.json()); // Allow JSON parsing
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 5000; 

// ── GLOBAL SOCKET VARIABLE ──
let sock;
let isPairing = false;

// ── 2. CONNECT DATABASE ──
connectDB(config.mongoURI);

// ── 3. START WHATSAPP BOT ──
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        logger: pino({ level: "silent" }),
        auth: state,
        browser: [config.botName, "Chrome", config.version]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect && !isPairing) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log(chalk.green(`\n[+] ${config.botName} Connected Successfully!`));
            console.log(chalk.yellow(`[+] Owner: ${config.ownerName}`));
            isPairing = false;
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

        isPairing = true; // Stop reconnect loop while pairing
        
        // Request the code from Baileys
        const code = await sock.requestPairingCode(phone.trim());
        
        console.log(chalk.cyan(`[+] Pairing code generated for ${phone}: ${code}`));
        
        res.json({ code: code });

    } catch (error) {
        console.error("Pairing error:", error);
        res.status(500).json({ error: error.message });
    }
});

// ── 5. LAUNCH ──
app.listen(PORT, '0.0.0.0', () => {
    console.log(chalk.cyan(`[+] Web Dashboard running on port ${PORT}`));
    startBot(); // Start bot in the background
});