import dns from 'dns';
dns.setServers(['8.8.8.8', '8.8.4.4']); 

import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import chalk from 'chalk';
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

import { connectDB } from './database/models.js';
import { presenter } from './presenter.js';
import { config } from './config.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 1. START WEB DASHBOARD (Port 5000, bound to 0.0.0.0) ──
const app = express();
const PORT = process.env.PORT || 5000;
app.use(express.static(path.join(__dirname, 'public')));
app.get('/status', (req, res) => res.json({ status: "online", bot: config.botName }));

app.listen(PORT, '0.0.0.0', () => {
    console.log(chalk.cyan(`[+] Web Dashboard running on http://0.0.0.0:${PORT}`));
});

// ── 2. CONNECT DATABASE ──
connectDB(config.mongoURI);

// ── 3. TERMINAL PROMPT FOR PAIRING CODE ──
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// ── 4. START WHATSAPP BOT ──
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        logger: pino({ level: "silent" }),
        auth: state,
        browser: [config.botName, "Chrome", config.version]
    });

    sock.ev.on('creds.update', saveCreds);

    // Pairing Code Method
    if (!sock.authState.creds.registered) {
        console.log(chalk.yellow('\n[!] WhatsApp is not linked.'));
        const phoneNumber = await question(chalk.cyan('Enter your WhatsApp number (e.g., 254794376595): '));
        
        // Small delay to ensure the socket is fully ready
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber.trim());
                console.log(chalk.green(`\n[+] YOUR PAIRING CODE: ${code}`));
                console.log(chalk.white('Go to WhatsApp > Linked Devices > Link with phone number instead.'));
                console.log(chalk.white('Enter the code above.\n'));
            } catch (err) {
                console.log(chalk.red(`[-] Failed to get pairing code: ${err.message}`));
            }
        }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log(chalk.green(`\n[+] ${config.botName} Connected Successfully!`));
            console.log(chalk.yellow(`[+] Owner: ${config.ownerName}`));
            rl.close(); 
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        await presenter(sock, m, config);
    });
}

startBot();