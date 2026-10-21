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

// ── 1. START WEB DASHBOARD ──
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));
app.get('/status', (req, res) => res.json({ status: "online", bot: config.botName }));
app.listen(PORT, () => {
    console.log(chalk.cyan(`[+] Web Dashboard running on http://localhost:${PORT}`));
});

// ── 2. CONNECT DATABASE ──
connectDB(config.mongoURI);

// ── 3. START WHATSAPP BOT ──
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        logger: pino({ level: "silent" }),
        printQRInTerminal: true,
        auth: state,
        browser: [config.botName, "Chrome", config.version]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log(chalk.green(`[+] ${config.botName} Connected Successfully!`));
            console.log(chalk.yellow(`[+] Owner: ${config.ownerName}`));
        }
    });

    // Hand off messages to the presenter (command handler)
    sock.ev.on('messages.upsert', async (m) => {
        await presenter(sock, m, config);
    });
}

startBot();