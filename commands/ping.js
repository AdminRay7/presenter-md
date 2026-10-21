export default async function (sock, msg) {
    const start = Date.now();
    await sock.sendMessage(msg.key.remoteJid, { text: `*Pong!* 🏓\nSpeed: ${Date.now() - start}ms` }, { quoted: msg });
}