export default async function (sock, msg, args, config) {
    const menuText = `*${config.botName}*\n` +
                     `_${config.tagline} v${config.version}_\n\n` +
                     `*Owner:* ${config.ownerName}\n` +
                     `*Email:* ${config.adminEmail}\n` +
                     `*Channel:* ${config.channelLink}\n\n` +
                     `*Available Commands:*\n` +
                     `• ${config.prefix}ping\n` +
                     `• ${config.prefix}menu\n` +
                     `• ${config.prefix}owner\n\n` +
                     `_${config.footer}_`;
                     
    await sock.sendMessage(msg.key.remoteJid, { 
        text: menuText,
        contextInfo: {
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: config.newsletterJid,
                newsletterName: config.botName,
                serverMessageId: 143
            }
        }
    }, { quoted: msg });
}