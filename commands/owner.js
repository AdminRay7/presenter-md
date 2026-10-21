export default async function (sock, msg, args, config) {
    const vcard = 'BEGIN:VCARD\n' +
                  'VERSION:3.0\n' +
                  `FN:${config.ownerName}\n` +
                  `TEL;type=CELL;type=VOICE;waid=${config.ownerNumber}:+${config.ownerNumber}\n` +
                  'END:VCARD';
                  
    await sock.sendMessage(msg.key.remoteJid, { 
        contacts: { 
            displayName: config.ownerName, 
            contacts: [{ vcard }] 
        } 
    }, { quoted: msg });
}