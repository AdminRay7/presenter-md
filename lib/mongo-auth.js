import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';

export async function useMongoDBAuthState(db, sessionId) {
    const collection = db.collection('authState');
    
    const writeData = async (data, key) => {
        await collection.updateOne(
            { sessionId, key },
            { $set: { value: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) } },
            { upsert: true }
        );
    };

    const readData = async (key) => {
        const doc = await collection.findOne({ sessionId, key });
        return doc ? JSON.parse(JSON.stringify(doc.value), BufferJSON.reviver) : null;
    };

    const removeData = async (key) => {
        await collection.deleteOne({ sessionId, key });
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}