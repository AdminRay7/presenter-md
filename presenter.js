import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function presenter(sock, m, config) {
    try {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const type = Object.keys(msg.message)[0];
        let body = '';
        
        if (type === 'conversation') body = msg.message.conversation;
        else if (type === 'extendedTextMessage') body = msg.message.extendedTextMessage.text;
        
        if (!body || !body.startsWith(config.prefix)) return;

        const args = body.slice(config.prefix.length).trim().split(/ +/);
        const commandName = args.shift().toLowerCase();

        const commandPath = path.join(__dirname, 'commands', `${commandName}.js`);
        
        if (fs.existsSync(commandPath)) {
            const commandModule = await import(`file://${commandPath}`);
            // Passes sock, msg, args, config, and the presenter itself for recursive calls
            await commandModule.default(sock, msg, args, config, presenter);
        }
    } catch (err) {
        console.error("Error in presenter:", err);
    }
}