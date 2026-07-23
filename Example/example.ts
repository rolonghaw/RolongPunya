import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'

// Nomor WA Kamu
const phoneNumber = "6285959863111"

async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        auth: state,
        // Matikan log bising agar QR link / XML tidak muncul lagi
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    })

    // Minta Pairing Code jika belum terhubung
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber)
                console.log('\n==================================================')
                console.log(' KODE PAIRING WHATSAPP KAMU ADALAH:')
                console.log(` --->  ${code}  <---`)
                console.log('==================================================\n')
            } catch (err) {
                console.error('Gagal mengambil pairing code:', err)
            }
        }, 3000)
    }

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut
            console.log('Koneksi terputus, menghubungkan kembali...', shouldReconnect)
            if (shouldReconnect) {
                startSock()
            }
        } else if (connection === 'open') {
            console.log('\n==================================================')
            console.log(' BOT BERHASIL TERHUBUNG KE WHATSAPP! ')
            console.log('==================================================\n')
        }
    })
}

startSock()
