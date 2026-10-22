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

const config = {
    botName: "303-XMD",
    ownerName: "Mr Presenter",
    ownerNumber: "254794376595",
    mongoURI: "mongodb://ryanAdmin:3063ERay@ac-m1jdocr-shard-00-00.iylgadk.mongodb.net:27017,ac-m1jdocr-shard-00-01.iylgadk.mongodb.net:27017,ac-m1jdocr-shard-00-02.iylgadk.mongodb.net:27017/?ssl=true&replicaSet=atlas-9cc0ub-shard-0&authSource=admin&retryWrites=true&w=majority"
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

async function bootSocket() {
    try {
        const database = await initMongo();
        const { state, saveCreds } = await useMongoDBAuthState(database);
        
        let version;
        try {
            const res = await fetchLatestWaWebVersion();
            version = res.version;
        } catch {
            // Fallback version if Heroku blocks the fetch
            version = [2, 3000, 1042466098]; 
        }

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
            },
            logger: pino({ level: "silent" }),
            browser: Browsers.macOS("Safari"),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 60000,
            retryRequestDelayMs: 2000,
            fireInitQueries: false
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
                    setTimeout(bootSocket, 5000);
                }
            } else if (connection === 'open') {
                console.log(chalk.green(`\n[+] Connected Successfully!`));
                isPairing = false;
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            await presenter(sock, m, config);
        });
    } catch (err) {
        console.log(chalk.red(`[-] BOOT ERROR: ${err.message}`));
    }
}

async function requestPairing(phoneNumber) {
    return enqueuePairing(async () => {
        await initMongo();
        if (sock) {
            try { sock.end(undefined); } catch(e) {}
            sock = null;
            socketReady = false;
        }
        await db.collection('authState').deleteMany({}); 
        await bootSocket();

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
        return code.match(/.{1,4}/g)?.join("-") || code;
    });
}

app.get("/api/pair", async (req, res) => {
    const num = String(req.query.num || "").replace(/\D/g, "");
    if (!num || num.length < 10 || num.length > 15) return res.status(400).json({ error: "Invalid phone number" });

    try {
        await initMongo(); 
        const code = await requestPairing(num);
        res.json({ success: true, code });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ── CRITICAL FIX: START SERVER FIRST ──
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(chalk.cyan(`[+] Web Dashboard running on port ${PORT}`));
    // Boot socket AFTER web server is running so Heroku doesn't crash
    bootSocket().catch(err => console.log(chalk.red(`Background boot error: ${err.message}`)));
});