import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import readline from 'readline'
import makeWASocket, { CacheStore, DEFAULT_CONNECTION_CONFIG, DisconnectReason, fetchLatestBaileysVersion, generateMessageIDV2, getAggregateVotesInPollMessage, isJidNewsletter, makeCacheableSignalKeyStore, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey } from '../src'
import P from 'pino'

const logger = P({
  level: "trace",
  transport: {
    targets: [
      {
        target: "pino-pretty", // pretty-print for console
        options: { colorize: true },
        level: "trace",
      },
      {
        target: "pino/file", // raw file output
        options: { destination: './wa-logs.txt' },
        level: "trace",
      },
    ],
  },
})
logger.level = 'trace'

const doReplies = process.argv.includes('--do-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache() as CacheStore

const onDemandMap = new Map<string, string>()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

// start a connection
const startSock = async() => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// NOTE: For unit testing purposes only
	if (process.env.ADV_SECRET_KEY) {
		state.creds.advSecretKey = process.env.ADV_SECRET_KEY
	}
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	logger.debug({version: version.join('.'), isLatest}, `using latest WA version`)

	const sock = makeWASocket({
		version,
		logger,
		waWebSocketUrl: process.env.SOCKET_URL ?? DEFAULT_CONNECTION_CONFIG.waWebSocketUrl,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		// shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries & poll updates
		getMessage
	})

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async(events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if(events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect, qr } = update
				if(connection === 'close') {
					// reconnect if not logged out
					if((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
						startSock()
					} else {
						logger.fatal('Connection closed. You are logged out.')
					}
				}

				if (qr) {
					// Pairing code for Web clients
					if (usePairingCode && !sock.authState.creds.registered) {
						const phoneNumber = await question('Please enter your phone number:\n')
						const code = await sock.requestPairingCode(phoneNumber)
						console.log(`Pairing code: ${code}`)
					}
				}

				logger.debug(update, 'connection update')
			}

			// credentials updated -- save them
			if(events['creds.update']) {
				await saveCreds()
				logger.debug({}, 'creds save triggered')
			}

			if(events['labels.association']) {
				logger.debug(events['labels.association'], 'labels.association event fired')
			}


			if(events['labels.edit']) {
				logger.debug(events['labels.edit'], 'labels.edit event fired')
			}

			if(events['call']) {
				logger.debug(events['call'], 'call event fired')
			}

			// history received
			if(events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set']
				if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
					logger.debug(messages, 'received on-demand history sync')
				}
				logger.debug({contacts: contacts.length, chats: chats.length, messages: messages.length, isLatest, progress, syncType: syncType?.toString() }, 'messaging-history.set event fired')
			}

			// received a new message
      if (events['messages.upsert']) {
        const upsert = events['messages.upsert']
        logger.debug(upsert, 'messages.upsert fired')
        const message = upsert.messages[0];
        if (message && message.message) {
            const teksMentah = message.message.conversation || message.message.extendedTextMessage?.text || message.message.imageMessage?.caption || '';
            const pesan = teksMentah.toLowerCase().trim();

            if (pesan.startsWith('.download') || pesan.startsWith('download')) {
                try {
                    let urlMedia = teksMentah.replace(/^\.download\s*/i, '').replace(/^download\s*/i, '').trim();
                    
                    if (!urlMedia) {
                        await sock.sendMessage(message.key.remoteJid, { 
                            text: '❌ *Format Salah!*\n\nSilakan ketik:\n`.download <link tiktok/ig/fb/yt>`' 
                        });
                        return;
                    }

                    await sock.sendMessage(message.key.remoteJid, { react: { text: '⏳', key: message.key } });

                    const { exec } = await import('child_process');
                    
                    // Menggunakan API publik dengan metode curl eksternal (Bypass proteksi network Node.js Termux)
                    const urlApi = `https://api.sandipbaruwal.com.np/download?url=${encodeURIComponent(urlMedia)}`;
                    
                    exec(`curl -s -L "${urlApi}"`, async (error, stdout, stderr) => {
                        try {
                            if (error || !stdout) {
                                throw new Error("Gagal mengambil data via curl");
                            }

                            const json = JSON.parse(stdout);
                            const videoUrl = json.data?.url || json.url || json.data?.main_url;

                            if (videoUrl) {
                                await sock.sendMessage(message.key.remoteJid, {
                                    video: { url: videoUrl },
                                    caption: `✅ *Berhasil Diunduh!*\n\n🤖 *Rolong Downloader*`
                                });
                                await sock.sendMessage(message.key.remoteJid, { react: { text: '✅', key: message.key } });
                            } else {
                                // Jika API pertama zonk, pakai API cadangan via curl
                                const fallbackUrl = `https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(urlMedia)}`;
                                exec(`curl -s -L "${fallbackUrl}"`, async (error2, stdout2) => {
                                    try {
                                        const json2 = JSON.parse(stdout2);
                                        const videoUrl2 = json2.video?.noWatermark || json2.data?.video || json2.result?.url;
                                        
                                        if (videoUrl2) {
                                            await sock.sendMessage(message.key.remoteJid, {
                                                video: { url: videoUrl2 },
                                                caption: `✅ *Berhasil Diunduh (Server B)!*`
                                            });
                                            await sock.sendMessage(message.key.remoteJid, { react: { text: '✅', key: message.key } });
                                        } else {
                                            await sock.sendMessage(message.key.remoteJid, { text: '❌ Server downloader sedang overload, coba link lain.' });
                                        }
                                    } catch (err3) {
                                        await sock.sendMessage(message.key.remoteJid, { text: '❌ Gagal memproses link di semua server.' });
                                    }
                                });
                            }
                        } catch (e) {
                            await sock.sendMessage(message.key.remoteJid, { text: '❌ Gagal memproses jaringan atau link tidak didukung.' });
                        }
                    });

                } catch (err) {
                    console.error(err);
                    await sock.sendMessage(message.key.remoteJid, { text: '❌ Terjadi gangguan internal pada script.' });
                }
                return;
            }

            switch (pesan) {
                case 'ping':
                case '.ping':
                    await sock.sendMessage(message.key.remoteJid, { text: 'pong' });
                    break;
                case 'menu':
                case '.menu':
                    await sock.sendMessage(message.key.remoteJid, { 
                        text: '*🤖 ROLONG BOT - SOSMED DOWNLOADER*\n\n• *.download <link>*\n  _(Mendukung YT, TikTok, IG, FB)_\n\n• *ping* - Cek respon bot' 
                    });
                    break;
            }
        }

        if (!!upsert.requestId) {
          logger.debug(upsert, 'placeholder request message received')
        }



        if (upsert.type === 'notify') {
          for (const msg of upsert.messages) {
            if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
              const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
              if (text == "requestPlaceholder" && !upsert.requestId) {
                const messageId = await sock.requestPlaceholderResend(msg.key)
								logger.debug({ id: messageId }, 'requested placeholder resync')
              }

              // go to an old chat and send this
              if (text == "onDemandHistSync") {
                const messageId = await sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp!)
                logger.debug({ id: messageId }, 'requested on-demand history resync')
              }

              if (!msg.key.fromMe && doReplies && !isJidNewsletter(msg.key?.remoteJid!)) {
              	const id = generateMessageIDV2(sock.user?.id)
              	logger.debug({id, orig_id: msg.key.id }, 'replying to message')
                await sock.sendMessage(msg.key.remoteJid!, { text: 'pong '+msg.key.id }, {messageId: id })
              }
            }
          }
        }
      }

			// messages updated like status delivered, message deleted etc.
			if(events['messages.update']) {
				logger.debug(events['messages.update'], 'messages.update fired')

				for(const { key, update } of events['messages.update']) {
					if(update.pollUpdates) {
						const pollCreation: proto.IMessage = {} // get the poll creation message somehow
						if(pollCreation) {
							console.log(
								'got poll update, aggregation: ',
								getAggregateVotesInPollMessage({
									message: pollCreation,
									pollUpdates: update.pollUpdates,
								})
							)
						}
					}
				}
			}

			if(events['message-receipt.update']) {
				logger.debug(events['message-receipt.update'])
			}

			if (events['contacts.upsert']) {
				logger.debug(events['message-receipt.update'])
			}

			if(events['messages.reaction']) {
				logger.debug(events['messages.reaction'])
			}

			if(events['presence.update']) {
				logger.debug(events['presence.update'])
			}

			if(events['chats.update']) {
				logger.debug(events['chats.update'])
			}

			if(events['contacts.update']) {
				for(const contact of events['contacts.update']) {
					if(typeof contact.imgUrl !== 'undefined') {
						const newUrl = contact.imgUrl === null
							? null
							: await sock!.profilePictureUrl(contact.id!).catch(() => null)
						logger.debug({id: contact.id, newUrl}, `contact has a new profile pic` )
					}
				}
			}

			if(events['chats.delete']) {
				logger.debug('chats deleted ', events['chats.delete'])
			}

			if(events['group.member-tag.update']) {
				logger.debug('group member tag update', JSON.stringify(events['group.member-tag.update'], undefined, 2))
			}
		}
	)

	return sock

	async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
	  // Implement a way to retreive messages that were upserted from messages.upsert
			// up to you

		// only if store is present
		return proto.Message.create({ conversation: 'test' })
	}
}

startSock()
