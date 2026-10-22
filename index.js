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
import jwt from 'jsonwebtoken';

import { config } from './config.js';
import { presenter } from './presenter.js';
import { useMongoDBAuthState } from './lib/mongo-auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── GLOBALS ──
let mongoClient, db;
global.sessions = new Map();
let pairingQueue = Promise.resolve();

// Queue to prevent double pairing requests
const enqueuePairing = (fn) => {
    const next = pairingQueue.then(fn, fn);
    pairingQueue = next.catch(() => {});
    return next;
};

// ── DATABASE INIT ──
async function initMongo() {
    if (db) return;
    try {
        mongoClient = new MongoClient(config.mongoURI);
        await mongoClient.connect();
        db = mongoClient.db("xmd303");
        console.log(chalk.green(`[+] MongoDB Connected Successfully`));
    } catch (e) {
        console.error(chalk.red(`[-] MongoDB Error: ${e.message}`));
    }
}

// ── BOOT SOCKET ──
async function bootSocket(sessionId, session) {
    const { state, saveCreds } = await useMongoDBAuthState(db, sessionId);
    const { version } = await fetchLatestWaWebVersion(); // Bypasses ghost codes

    const conn = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
        },
        logger: pino({ level: "silent" }),
        browser: Browsers.macOS("Safari"), // Mimics macOS Safari
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

    session.conn = conn;
    conn.ev.on('creds.update', saveCreds);

    conn.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'connecting') {
            session.socketReady = true;
        }

        if (connection === 'close') {
            session.socketReady = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(() => bootSocket(sessionId, session), 5000);
            } else {
                global.sessions.delete(sessionId);
            }
        } else if (connection === 'open') {
            console.log(chalk.green(`[+] [${sessionId}] Connected Successfully!`));
        }
    });

    conn.ev.on('messages.upsert', async (m) => {
        await presenter(conn, m, config);
    });
}

// ── PAIRING LOGIC (The exact flow you provided) ──
async function requestPairingCodeForSession(sessionId, phoneNumber) {
    return enqueuePairing(async () => {
        await initMongo();
        let session = global.sessions.get(sessionId);

        if (session?.conn?.user) throw new Error("Session already paired");
        if (session?.pairing && session.pairingNumber === phoneNumber) return session.pairing;

        if (!session) {
            if (global.sessions.size >= config.maxSessions) {
                throw new Error(`Server at capacity (${config.maxSessions})`);
            }
            session = { conn: null, socketReady: false, pairing: null, pairingNumber: null };
            global.sessions.set(sessionId, session);
            await bootSocket(sessionId, session);
        }

        // Wait for socket to become ready (30s timeout)
        const deadline = Date.now() + 30000;
        while (!session.socketReady && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 500));
        }
        if (!session.socketReady) throw new Error("Socket not ready, try again");

        // Request the code
        let code;
        try { 
            code = await session.conn.requestPairingCode(phoneNumber); 
        } catch { 
            await new Promise(r => setTimeout(r, 2000)); 
            code = await session.conn.requestPairingCode(phoneNumber); 
        }

        const formatted = code.match(/.{1,4}/g)?.join("-") || code;
        session.pairing = formatted;
        session.pairingNumber = phoneNumber;
        console.log(chalk.green(`[+] [${sessionId}] pairing code: ${formatted}`));
        return formatted;
    });
}

// ── API ROUTE ──
app.get("/api/pair", async (req, res) => {
    const sessionId = String(req.query.sessionId || "").trim();
    const num = String(req.query.num || "").replace(/\D/g, "");

    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
    if (!num || num.length < 10 || num.length > 15) return res.status(400).json({ error: "Invalid phone number" });

    // Optional: Verify JWT token here if you want to secure the API
    // const token = req.headers.authorization?.split(" ")[1];
    // if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
        const code = await requestPairingCodeForSession(sessionId, num);
        
        // Save to database as requested in your flow
        await db.collection('SessionSettings').updateOne(
            { sessionId },
            { $set: { phoneNumber: num, updatedAt: new Date() } },
            { upsert: true }
        );

        res.json({ success: true, sessionId, code });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ── LAUNCH SERVER ──
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(chalk.cyan(`[+] Web Dashboard running on port ${PORT}`));
    await initMongo();
});