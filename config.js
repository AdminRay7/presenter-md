import dotenv from 'dotenv';
dotenv.config();

export const config = {
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
    mongoURI: process.env.MONGO_URI || "mongodb+srv://ryanAdmin:3063ERay@cluster0.iy1gadk.mongodb.net/?appName=Cluster0",
    jwtSecret: process.env.JWT_SECRET || "super_secret_303_key",
    maxSessions: 10 // Limit concurrent WhatsApp connections
};