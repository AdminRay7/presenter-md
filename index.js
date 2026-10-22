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

// ═════════════════════════════════
// BOT IDENTITY & CONFIGURATION
// ═════════════════════════════════
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
global.sessions = new Map();
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
async function bootSocket(sessionId, session) {
    session.id = sessionId;
    await initMongo();

    const collection = db.collection("authState");
    const { state, saveCreds } = await useMongoDBAuthState(collection, sessionId);
    
    // THIS IS THE MAGIC LINE FOR PAIRING
    const { version } = await fetchLatestWaWebVersion();
    console.log(chalk.cyan(`[+] Using WA Version: ${version.join('.')}`));

    const conn = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
        },
        logger: pino({ level: "silent" }),
        browser: Browsers.macOS("Safari"), // Mimics Mac
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
    conn.ev.on("creds.update", saveCreds);

    conn.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "connecting") {
            session.socketReady = true;
        }

        if (connection === "open") {
            session.socketReady = true;
            session.pairing = null;
            console.log(chalk.green(`[+] Session ${sessionId} connected as ${conn.user?.id}`));
        }

        if (connection === "close") {
            session.socketReady = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === 401 || code === DisconnectReason.loggedOut) {
                // Logged out, delete session
                global.sessions.delete(sessionId);
                return;
            }
            setTimeout(() => {
                if (!global.sessions.has(sessionId)) return;
                bootSocket(sessionId, session).catch(e => console.error(`Reconnect ${sessionId}:`, e.message));
            }, 5000);
        }
    });

    conn.ev.on("messages.upsert", async (m) => {
        try { await presenter(conn, m, config); } catch (err) {}
    });

    return conn;
}

// ── PAIRING LOGIC (No Session Locks) ──
async function requestPairingCodeForSession(sessionId, phoneNumber) {
    return enqueuePairing(async () => {
        await initMongo();
        let session = global.sessions.get(sessionId);

        // If it's already connected, we wipe it to allow re-pairing
        if (session?.conn?.user) {
            try { session.conn.ws.close(); } catch(e){}
            await db.collection('authState').deleteMany({ sessionId });
            session = null;
        }

        // Create new session object
        if (!session) {
            session = { conn: null, socketReady: false, pairing: null, pairingNumber: null };
            global.sessions.set(sessionId, session);
            await bootSocket(sessionId, session);
        }

        // Wait for socket to be ready
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
    const sessionId = String(req.query.sessionId || "default").trim();
    const num = String(req.query.num || "").replace(/\D/g, "");

    if (!num || num.length < 10 || num.length > 15) {
        return res.status(400).json({ error: "Invalid phone number" });
    }

    try {
        await initMongo(); 
        const code = await requestPairingCodeForSession(sessionId, num);
        
        await db.collection('SessionSettings').updateOne(
            { sessionId },
            { $set: { phoneNumber: num, updatedAt: new Date() } },
            { upsert: true }
        );

        res.json({ success: true, sessionId, code });
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
        // We don't auto-boot here anymore because you want pairing anytime.
        // The /api/pair route boots it on demand.
    } catch (e) {
        console.log(chalk.red(`[-] Failed to start DB.`));
    }
});