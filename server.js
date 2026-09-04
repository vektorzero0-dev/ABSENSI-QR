const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Memory storage untuk menampung sesi socket WA per userId
const waSessions = {};

// FUNGSIONALITAS UTAMA BAILEYS WA
async function initWA(userId) {
    const authFolder = path.join(__dirname, 'auth_sessions', `user_${userId}`);
    
    if (!fs.existsSync(authFolder)) {
        fs.mkdirSync(authFolder, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    waSessions[userId] = {
        sock: sock,
        statusWA: 'MENUNGGU_SCAN',
        qrCodeWA: null,
        pairingCode: null
    };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                // Konversi teks QR string menjadi Base64 DataURL
                waSessions[userId].qrCodeWA = await QRCode.toDataURL(qr);
                waSessions[userId].statusWA = 'MENUNGGU_SCAN';
                console.log(`[WA] QR Code berhasil dibuat untuk user: ${userId}`);
            } catch (err) {
                console.error(`[WA] Gagal generate gambar QR:`, err);
            }
        }

        if (connection === 'open') {
            waSessions[userId].statusWA = 'TERHUBUNG';
            waSessions[userId].qrCodeWA = null;
            waSessions[userId].pairingCode = null;
            console.log(`[WA] Perangkat User ${userId} Berhasil TERHUBUNG!`);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`[WA] Koneksi terputus untuk user ${userId}. Reason code: ${statusCode}`);

            if (shouldReconnect) {
                console.log(`[WA] Mengatur ulang koneksi ulang (reconnect)...`);
                initWA(userId);
            } else {
                waSessions[userId].statusWA = 'BELUM_TERHUBUNG';
                waSessions[userId].qrCodeWA = null;
                waSessions[userId].pairingCode = null;
                if (fs.existsSync(authFolder)) {
                    fs.rmSync(authFolder, { recursive: true, force: true });
                }
            }
        }
    });
}

// 1. ENDPOINT INISIALISASI WA (SCAN QR)
app.get('/api/start-wa', async (req, res) => {
    const userId = req.query.userId || 'admin';
    try {
        if (!waSessions[userId] || waSessions[userId].statusWA === 'BELUM_TERHUBUNG') {
            await initWA(userId);
        }
        res.json({ success: true, message: "Inisialisasi WA berhasil diproses." });
    } catch (err) {
        console.error("Error start-wa:", err);
        res.status(500).json({ success: false, message: "Gagal menginisialisasi WA." });
    }
});

// 2. ENDPOINT REQUEST PAIRING CODE (NOMOR HP)
app.get('/api/request-pairing', async (req, res) => {
    const userId = req.query.userId || 'admin';
    let phone = req.query.phone || '';

    // Formating & Sanitasi Nomor HP
    phone = phone.replace(/[^0-9]/g, '');
    if (phone.startsWith('0')) {
        phone = '62' + phone.slice(1);
    }

    if (!phone || phone.length < 10) {
        return res.status(400).json({ success: false, message: "Nomor WhatsApp tidak valid!" });
    }

    try {
        if (!waSessions[userId] || !waSessions[userId].sock) {
            await initWA(userId);
        }

        // Berikan jeda sebentar agar socket Baileys siap menerima instruksi pairing
        setTimeout(async () => {
            try {
                const sock = waSessions[userId].sock;
                if (sock && !sock.authState.creds.registered) {
                    const code = await sock.requestPairingCode(phone);
                    waSessions[userId].pairingCode = code;
                    waSessions[userId].statusWA = 'MENUNGGU_PAIRING_CODE';
                    return res.json({ success: true, pairingCode: code });
                }
                res.json({ success: false, message: "Sesi sudah terdaftar atau socket belum siap." });
            } catch (err) {
                console.error("Error request pairing internal:", err);
                res.status(500).json({ success: false, message: "Gagal meminta kode tautan dari server WA." });
            }
        }, 3000);
    } catch (err) {
        console.error("Error request-pairing route:", err);
        res.status(500).json({ success: false, message: "Terjadi kesalahan sistem." });
    }
});

// 3. ENDPOINT STATUS WA (PULLED BY DASHBOARD IN REALTIME)
app.get('/api/wa-status', (req, res) => {
    const userId = req.query.userId || 'admin';
    const session = waSessions[userId] || {
        statusWA: 'BELUM_TERHUBUNG',
        qrCodeWA: null,
        pairingCode: null
    };

    res.json({
        statusWA: session.statusWA,
        qrCodeWA: session.qrCodeWA,
        pairingCode: session.pairingCode
    });
});

// 4. ENDPOINT RESET SESI WA
app.get('/api/reset-wa', (req, res) => {
    const userId = req.query.userId || 'admin';
    const authFolder = path.join(__dirname, 'auth_sessions', `user_${userId}`);

    if (waSessions[userId] && waSessions[userId].sock) {
        try {
            waSessions[userId].sock.end(undefined);
        } catch (e) {}
    }

    delete waSessions[userId];

    if (fs.existsSync(authFolder)) {
        fs.rmSync(authFolder, { recursive: true, force: true });
    }

    res.json({ success: true, message: "Sesi WA berhasil direset secara bersih. Silakan coba tautkan ulang." });
});

// ROUTE HALAMAN DASHBOARD ADMIN
app.get('/admin', (req, res) => {
    const userId = req.query.userId || 'admin';
    res.render('admin-dashboard', {
        namaSekolah: 'UPTD SD NEGERI 1 KARYA MULYA SARI',
        alamatSekolah: 'Karya Mulya Sari, Kec. Candipuro',
        modePengirimWA: 'ADMIN',
        izinkanGuruPilihWA: 'TIDAK',
        userId: userId,
        users: [],
        siswa: [],
        kelas: [],
        absensiHariIni: []
    });
});

// ROUTE HALAMAN DASHBOARD WALI KELAS
app.get('/wali', (req, res) => {
    const userId = req.query.userId || 'guru1';
    res.render('walikelas-dashboard', {
        namaSekolah: 'UPTD SD NEGERI 1 KARYA MULYA SARI',
        userId: userId,
        user: { nama: 'Wali Kelas', nama_kelas: 'Kelas 1A', kelas_id: 1 },
        modePengirimWAAdmin: 'ADMIN',
        izinkanGuruPilihWA: 'TIDAK',
        siswaList: [],
        absensiHariIni: []
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(`Server Absensi Sekolah Berjalan di Port ${PORT}`);
    console.log(`Buka Admin : http://localhost:${PORT}/admin`);
    console.log(`===========================================`);
});
