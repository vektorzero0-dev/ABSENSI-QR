const { BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');

async function useNeonAuthState(pool, userId = 'default') {
    // Fungsi membaca data sesi dari tabel wa_sessions di Neon Postgres
    const readData = async (type, id) => {
        try {
            const key = `${userId}:${type}:${id}`;
            const res = await pool.query('SELECT session_data FROM wa_sessions WHERE key_id = $1', [key]);
            if (res.rows.length > 0) {
                return JSON.parse(res.rows[0].session_data, BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            console.error('Error membaca sesi dari Neon:', error);
            return null;
        }
    };

    // Fungsi menulis/memperbarui data sesi di tabel wa_sessions
    const writeData = async (data, type, id) => {
        try {
            const key = `${userId}:${type}:${id}`;
            const value = JSON.stringify(data, BufferJSON.replacer);
