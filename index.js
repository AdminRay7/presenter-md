import dns from 'dns';
dns.setServers(['8.8.8.8', '8.8.4.4']); 

import makeWASocket, { 
    DisconnectReason, 
    Browsers, 
    makeCacheableSignalKeyStore, 
    fetchLatestWaWebVersion 
} from '@whiskeysockets/baileys';
import pino from 'pino';
import chalk from 'chalk';
import express from 'express';
import path from 'path';
import { MongoClient } from 'mongodb';
import { fileURLToPath } from 'url';

import { presenter } from './presenter.js';
import { useMongoDBAuthState } from './lib/mongo-auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── BOT CONFIGURATION (All in one place) ──
const config = {
    botName: "303-XMD",
    tagline: "The Last Key",
    version: "2.0.0",
    prefix: ".",
    ownerName: "Mr Presenter",
    ownerNumber: "254794376595",
    adminEmail: "ryanobanga243@gmail.com",
    footer: "303-XMD — THE LAST KEY",
    channelLink: "https://whatsapp.com/channel/0029VbDUltrC6Zve91V0GW1u",
    newsletterJid: "120363430114825309@newsletter",
    // Legacy String to prevent DNS crash on Heroku
    mongoURI: "mongodb://ryanAdmin:3063ERay@ac-m1jdocr-shard-00-00.iylgadk.mongodb.net:27017,ac-m1jdocr-shard-00-01.iylgadk.mongodb.net:27017,ac-m1jdocr-shard-00-02.iylgadk.mongodb.net:27017/?ssl=true&replicaSet=atlas-9cc0ub-shard-0&authSource=admin&retryWrites=true&w=majority"
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── GLOBALS ──
let mongoClient, db;
let sock; 
let socketReady = false;
let isPairing = false;
let pairingQueue = Promise.resolve();

const enqueuePairing = (fn) => {
    const next = pairingQueue.then(fn, fn);
    pairingQueue = next.catch(() => {});
    return next;
};

// ── DATABASE INIT ──
async function initMongo() {
    if (db) return db;
    try {
        mongoClient = new MongoClient(config.mongoURI);
        await mongoClient.connect();
        db = mongoClient.db("xmd303");
        console.log(chalk.green(`[+] MongoDB Connected Successfully`));
        return db;
    } catch (e) {
        console.error(chalk.red(`[-] MongoDB Connection Error: ${e.message}`));
        throw e;
    }
}

// ── BOOT SOCKET ──
async function bootSocket() {
    const database = await initMongo();
    const { state, saveCreds } = await useMongoDBAuthState(database);
    const { version } = await fetchLatestWaWebVersion();

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
        },
        logger: pino({ level: "silent" }),
        browser: Browsers.macOS("Safari"), // Prevents ghost code
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 60000,
        retryRequestDelayMs: 2000,
        fireInitQueries: false,
        emitOwnEvents: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'connecting') {
            socketReady = true;
        }

        if (connection === 'close') {
            socketReady = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect && !isPairing) {
                console.log(chalk.yellow('[!] Connection closed. Reconnecting...'));
                setTimeout(bootSocket, 5000);
            }
        } else if (connection === 'open') {
            console.log(chalk.green(`\n[+] 303-XMD Connected Successfully!`));
            isPairing = false;
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        await presenter(sock, m, config);
    });
}

// ── PAIRING LOGIC ──
async function requestPairing(phoneNumber) {
    return enqueuePairing(async () => {
        await initMongo();
        
        if (!sock) await bootSocket();
        if (sock.authState.creds.registered) throw new Error("Bot is already linked to a WhatsApp account.");

        const deadline = Date.now() + 30000;
        while (!socketReady && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 500));
        }
        if (!socketReady) throw new Error("Socket not ready, try again");

        isPairing = true;
        let code;
        try { 
            code = await sock.requestPairingCode(phoneNumber); 
        } catch { 
            await new Promise(r => setTimeout(r, 2000)); 
            code = await sock.requestPairingCode(phoneNumber); 
        }

        const formatted = code.match(/.{1,4}/g)?.join("-") || code;
        console.log(chalk.green(`[+] Pairing code generated: ${formatted}`));
        return formatted;
    });
}

// ── API ROUTE ──
app.get("/api/pair", async (req, res) => {
    const num = String(req.query.num || "").replace(/\D/g, "");

    if (!num || num.length < 10 || num.length > 15) {
        return res.status(400).json({ error: "Invalid phone number" });
    }

    try {
        await initMongo(); 
        const code = await requestPairing(num);
        
        await db.collection('SessionSettings').updateOne(
            { botId: '303-XMD' },
            { $set: { phoneNumber: num, updatedAt: new Date() } },
            { upsert: true }
        );

        res.json({ success: true, code });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// ── LAUNCH SERVER ──
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(chalk.cyan(`[+] Web Dashboard running on port ${PORT}`));
    try {
        await initMongo();
        await bootSocket();
    } catch (e) {
        console.log(chalk.red(`[-] Failed to start bot automatically. Waiting for manual pair from web.`));
    }
});