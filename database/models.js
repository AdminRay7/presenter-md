import mongoose from 'mongoose';
import chalk from 'chalk';

export async function connectDB(uri) {
    try {
        await mongoose.connect(uri);
        console.log(chalk.green(`[+] Connected to MongoDB Database`));
    } catch (err) {
        console.log(chalk.red(`[-] MongoDB Error: ${err.message}`));
    }
}

// Example User Model (for storing prefixes, warnings, etc.)
const userSchema = new mongoose.Schema({
    jid: { type: String, required: true, unique: true },
    name: { type: String, default: 'User' },
    isPremium: { type: Boolean, default: false },
    warnings: { type: Number, default: 0 }
});

export const User = mongoose.model('User', userSchema);