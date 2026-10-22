import 'dotenv/config';
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
import https from 'https';
import http from 'http';
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
    // Hardcoded fallback so you don't need Heroku Vars
    mongoURI: process.env.MONGO_URI || "mongodb://ryanAdmin:3063ERay@ac-m1jdocr-shard-00-00.iylgadk.mongodb.net:27017,ac-m1jdocr-shard-00-01.iylgadk.mongodb.net:27017,ac-m1jdocr-shard-00-02.iylgadk.mongodb.net:27017/?ssl=true&replicaSet=atlas-9cc0ub-shard-0&authSource=admin&retryWrites=true&w=majority"
};

// ── GLOBAL ERROR HANDLERS ──
process.on("unhandledRejection", (e) => {
    console.error(chalk.red("[unhandledRejection]"), e?.message || e);
});
process.on("uncaughtException", (e) => {
    console.error(chalk.red("[uncaughtException]"), e?.message || e);
});

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, 'public')));

// ── GLOBALS ──
let mongoClient, db;
global.sessions = new Map();
let pairingQueue = Promise.resolve();

// Basic in-memory rate limiter (per IP)
const pairAttempts = new Map();
const PAIR_COOLDOWN_MS = 60_000;

const enqueuePairing = (fn) => {
    const next = pairingQueue.then(fn, fn);
    pairingQueue = next.catch(() => {});
    return next;
};

// ── DATABASE INIT ──
async function initMongo() {
    if (db) return db;
    try {
        mongoClient = new MongoClient(config.mongoURI, {
            serverSelectionTimeoutMS: 15000,
            connectTimeoutMS: 15000,
        });
        await mongoClient.connect();
        db = mongoClient.db("xmd303");
        console.log(chalk.green(`[+] MongoDB Connected Successfully`));
        return db;
    } catch (e) {
        console.error(chalk.red(`[-] MongoDB Connection Error: ${e.message}`));
        mongoClient = null;
        db = null;
        throw e;
    }
}

// ── SOCKET BOOT ──
async function bootSocket(sessionId, session) {
    session.id = sessionId;
    session.socketReady = false;

    await initMongo();

    const collection = db.collection("authState");
    const { state, saveCreds } = await useMongoDBAuthState(collection, sessionId);

    // Fetch WA version safely — fallback if network blips
    let version;
    try {
        ({ version } = await fetchLatestWaWebVersion());
        console.log(chalk.cyan(`[+] [${sessionId}] WA version: ${JSON.stringify(version)}`));
    } catch (e) {
        version = [2, 3000, 1023223821];
        console.warn(chalk.yellow(`[!] [${sessionId}] Could not fetch WA version, using fallback`));
    }

    const conn = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
        },
        logger: pino({ level: "silent" }),
        browser: Browsers.macOS("Safari"),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 60000,
        retryRequestDelayMs: 2000,
        emitOwnEvents: false
    });

    session.conn = conn;

    conn.ev.on("creds.update", saveCreds);

    conn.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "connecting") {
            console.log(chalk.cyan(`[+] [${sessionId}] connecting...`));
        }

        if (connection === "open") {
            session.socketReady = true;
            session.pairing = null;
            session.pairingNumber = null;
            session.pairingInFlight = false;
            console.log(chalk.green(`[+] [${sessionId}] connected as ${conn.user?.id}`));
        }

        if (connection === "close") {
            session.socketReady = false;
            session.pairingInFlight = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(chalk.red(`[-] [${sessionId}] closed (${code})`));

            try { conn.end(undefined); } catch {}
            if (session.conn === conn) session.conn = null;

            if (code === 401 || code === DisconnectReason.loggedOut) {
                global.sessions.delete(sessionId);
                return;
            }

            setTimeout(() => {
                if (!global.sessions.has(sessionId)) return;
                if (global.sessions.get(sessionId).conn) return;
                bootSocket(sessionId, session).catch(e =>
                    console.error(`Reconnect ${sessionId}:`, e.message)
                );
            }, 5000);
        }
    });

    conn.ev.on("messages.upsert", async (m) => {
        try { await presenter(conn, m, config); } catch (err) {
            console.error(`[presenter] ${err.message}`);
        }
    });

    return conn;
}

// ── PAIRING LOGIC ──
async function requestPairingCodeForSession(sessionId, phoneNumber) {
    return enqueuePairing(async () => {
        await initMongo();

        let session = global.sessions.get(sessionId);

        if (session?.conn?.user) throw new Error("Session already paired");

        if (session?.pairing && session.pairingNumber === phoneNumber) {
            return session.pairing;
        }

        if (session?.pairingInFlight) {
            throw new Error("Pairing already in progress for this session. Please wait.");
        }

        if (!session) {
            session = {
                conn: null,
                socketReady: false,
                pairing: null,
                pairingNumber: null,
                pairingInFlight: false,
                startedAt: Date.now()
            };
            global.sessions.set(sessionId, session);
            await bootSocket(sessionId, session);
        } else if (!session.conn) {
            await bootSocket(sessionId, session);
        }

        session.pairingInFlight = true;
        try {
            const deadline = Date.now() + 30_000;
            while (!session.socketReady && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 500));
            }
            if (!session.socketReady) {
                throw new Error("Socket not ready, try again in a few seconds");
            }

            let code;
            try {
                code = await session.conn.requestPairingCode(phoneNumber);
            } catch (e) {
                await new Promise(r => setTimeout(r, 2000));
                code = await session.conn.requestPairingCode(phoneNumber);
            }

            const formatted = code.match(/.{1,4}/g)?.join("-") || code;
            session.pairing = formatted;
            session.pairingNumber = phoneNumber;
            console.log(chalk.green(`[+] [${sessionId}] pairing code: ${formatted}`));
            return formatted;
        } catch (err) {
            session.pairing = null;
            session.pairingNumber = null;
            throw err;
        } finally {
            session.pairingInFlight = false;
        }
    });
}

// ── HEALTH CHECK ──
app.get("/health", (_req, res) => {
    res.json({ ok: true, sessions: global.sessions.size, uptime: process.uptime() });
});

// ── API ROUTE ──
app.post("/api/pair", async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const last = pairAttempts.get(ip) || 0;
    
    if (now - last < PAIR_COOLDOWN_MS) {
        const wait = Math.ceil((PAIR_COOLDOWN_MS - (now - last)) / 1000);
        return res.status(429).json({ error: `Please wait ${wait}s before trying again.` });
    }

    const sessionId = String(req.body?.sessionId || "main").trim();
    const num = String(req.body?.num || "").replace(/\D/g, "");

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

        pairAttempts.set(ip, Date.now());
        res.json({ success: true, sessionId, code });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// ── LAUNCH SERVER ──
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', async () => {
    console.log(chalk.cyan(`[+] Web Dashboard running on port ${PORT}`));

    try {
        await initMongo();
        const collection = db.collection("authState");
        const hasSession = await collection.findOne({ _id: "main:creds" });

        if (hasSession) {
            console.log(chalk.cyan(`[+] Found existing session in DB. Auto-connecting...`));
            const session = {
                conn: null,
                socketReady: false,
                pairing: null,
                pairingNumber: null,
                pairingInFlight: false,
                startedAt: Date.now()
            };
            global.sessions.set("main", session);
            await bootSocket("main", session);
        } else {
            console.log(chalk.yellow(`[!] No session found. Please pair via the web dashboard.`));
        }
    } catch (e) {
        console.log(chalk.red(`[-] Failed to start bot automatically: ${e.message}`));
    }
});

// ── GRACEFUL SHUTDOWN ──
async function shutdown(signal) {
    console.log(chalk.yellow(`\n[!] ${signal} received, shutting down...`));
    server.close();
    for (const [, sess] of global.sessions) {
        try { sess.conn?.end(undefined); } catch {}
    }
    try { await mongoClient?.close(); } catch {}
    process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── KEEP-ALIVE (Auto-detects your Heroku app URL) ──
// If you don't have HEROKU_APP_NAME in vars, it defaults to your app name "lastkey"
const appName = process.env.HEROKU_APP_NAME || "lastkey";
if (process.env.BASE_URL || appName) {
    const selfUrl = process.env.BASE_URL || `https://${appName}.herokuapp.com`;
    const client = selfUrl.startsWith('https:') ? https : http;

    const ping = () => {
        const req = client.get(`${selfUrl}/health`, (res) => {
            res.on('data', () => {});
            res.on('end', () => {
                if (res.statusCode >= 400)
                    console.warn(chalk.yellow(`[keep-alive] /health -> ${res.statusCode}`));
            });
        });
        req.on('error', (e) =>
            console.warn(chalk.yellow(`[keep-alive] ping failed: ${e.message}`)));
        req.setTimeout(15000, () => req.destroy());
    };

    setInterval(ping, 20 * 60 * 1000); // every 20 min
    console.log(chalk.cyan(`[+] Keep-alive pinging ${selfUrl}/health every 20 min`));
}