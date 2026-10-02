# Netcode map — pinned 0.8.1

Source root: `upstream/melee-unlocked`, commit `3aab7172db243c159afa76ecb2c564b3de8e4c0a`. Paths below are relative to that root. Abbreviated HLE filenames mean `port/runtime/hle/…`. Transport/backend changes below are **proposed seams**, not interfaces already implemented in the checkout.

## Device, client and ownership

| Layer | Files / entry points | Responsibility and evidence |
|---|---|---|
| Guest EXI SDK HLE | `hle_stubs.cpp`, EXI handlers | Channel 1 (slot B) selects Slippi; channel 0/device 1 serves RTC/SRAM. Route DMA to device and complete guest transfers |
| Device | `exi_slippi.h`; `exi_slippi.cpp:429–453,460–529` | `slippi::init/shutdown`, `dma_write/dma_read`, `imm_write/imm_read`; command-size parsing, response queue, replay events/files, Gecko and Sys resource delivery. Immediate write is no-op/read returns zero |
| Command schema | `exi_slippi.cpp:38–61`; `native_slippi_bridge.h:10–59` | B0 input exchange, B1 capture, B2 load, B3 match state, B4 search, B5 selection, B6 login, B7 logout, B8 update, B9 status; fixed payload validation also shared with native callers |
| Online device behavior | `slippi_online.h`; `slippi_online.cpp:1221–1260` | `online::handle` validates/routes requests; owns concrete `User`, `Matchmaking`, `NetplayClient`, local selections/checksums/savestate pool. Produces guest replies, not raw network datagrams |
| Peer netplay | `slippi_net.h`, `slippi_net.cpp:238–789` | `NetplayClient`: peer lifecycle, received pad queues, application ACKs, timing estimates, selections/chat/build messages; `SendSlippiPad`, `GetSlippiRemotePad`, `StartSlippiGame`, `SetMatchSelections`, `SendChatMessage`, disconnect/status APIs |
| Rendezvous | `slippi_net.cpp:785–1090` | `Matchmaking::FindMatch`, `MatchmakeThread`, `startMatchmaking`, `handleMatchmaking`, `ingest_ticket`, `handleConnecting`; finds players, then constructs netplay client |
| Identity/history | `slippi_net.cpp` `User` and `DirectCodes`; `slippi_online.cpp:1115+` | Reads Slippi Launcher `user.json`, refreshes user information, maintains Direct/Teams code history; searches native filesystem login locations |
| Reporting | `slippi_report.*` | Asynchronous game report and optional replay upload, separate from peer packets |
| Replay/native variants | `slippi_playback.*`, `native_replay_stream.*`, `native_savestate.*`, `native_slippi_bridge.h` | Playback and source-port snapshot/EXI bridging; do not confuse source-port write-watch snapshots with static recomp RAM rollback |

## ENet coupling and exact API surface

`port/third_party/enet/` is compiled into `port_enet`, linked with `ws2_32` and `winmm` (`port/CMakeLists.txt:196–200`). The only runtime C++ ENet integration is concentrated in `slippi_net.cpp`, with an explicit `enet_ready()` gate in `slippi_online.cpp:561`. ENet is also used for matchmaking, so changing peer send/receive alone cannot enable browser online menus.

| Operation | Exact ENet calls / data access | Source |
|---|---|---|
| Init | `enet_initialize` through `enet_ready` | `slippi_net.cpp:103–106` |
| Open/connect | `enet_host_create`, `enet_address_set_host`, `enet_host_connect`; peer host uses 10 peer capacity and 3 channels | `:238–259`; matchmaking `:940–947` |
| Poll/receive | `enet_host_service`; switch `ENET_EVENT_TYPE_CONNECT/RECEIVE/DISCONNECT`; construct `Packet(ev.packet->data, ev.packet->dataLength)`; `enet_packet_destroy` | `:477–623`; matchmaking receive `:861–877` |
| Send | `enet_packet_create`, `enet_peer_send`; application ACK sent directly to incoming peer; general `Send` loops selected peers | `:323–328,438–451` |
| Shutdown | `enet_peer_disconnect`, drain `enet_host_service(...,3000)`, `enet_peer_reset`, `enet_host_destroy` | `:269–273,454–467,827–838` |
| Wake blocked worker | `enet_socket_get_address`, `enet_socket_send` of a wake datagram; `client_->intercept` filters it | `:108–120`; `SendAsync:470–475`, matchmaking `:957` |
| Discover local LAN address | `enet_socket_create(ENET_SOCKET_TYPE_DATAGRAM)`, `enet_socket_connect`, `enet_socket_get_address`, `enet_socket_destroy` | `:841–852` |
| Matchmaking JSON | `mm_send`: JSON serialization→reliable ENet packet/channel 0; `mm_receive`: service events→JSON | `:855–877` |
| Peer identity/state | `_ENetHost*`, `_ENetPeer*`, peer `address.host/port`, `host->socket`, receive intercept and pointer-keyed connection maps | `slippi_net.h` private members; `slippi_net.cpp:285–300,477–623` |

There is no existing virtual transport: `NetplayClient` and `Matchmaking` are concrete classes, their destructors/methods are nonvirtual, and constructors start native network/thread work. `NetplayClient::Send` alone is **not** a sufficient override seam: `OnData` sends ACKs directly and inspects ENet addresses; `ThreadFunc`, wakeup and disconnect also bypass it.

Two explicit refactoring choices:

1. **Retain protocol logic; inject transport (preferred small protocol change).** Extract virtual operations for open/connect, send(peer, channel, reliability, bytes), event polling/delivery, close/disconnect/reset and wakeup from `NetplayClient` constructor, `Send`, `OnData`'s ACK branch, `ThreadFunc`, `Disconnect`, `SendAsync` and `ForceDisconnectPlayer`. Replace `_ENetPeer*` arguments/maps and `peer_key` with stable peer IDs. These virtual transport operations are new API, not existing function names. Preserve application ACKs/redundant pad bundles/time sync above it. Browser events replace blocking `enet_host_service` waits; SDP/ICE signaling and relay policy are **unknown — needs investigation**.
2. **Substitute the entire client with an interface.** Make `~NetplayClient` and the online-facing methods virtual (or move them into a pure interface): `IsDecider`, `LocalPlayerPort`, `GetSlippiConnectStatus`, `GetFailedConnections`, `StartSlippiGame`, `SendSlippiPad`, `SetMatchSelections`, `GetSlippiRemotePad`, `DropOldRemoteInputs`, `GetActivePlayerIndices`, `ForceDisconnectPlayer`, `ForceDisconnect`, `GetDisconnectReason`, `GetMatchInfo`, `GetSlippiRemoteChatMessage`, `GetSlippiRemoteSentChatMessage`, `CalcTimeOffsetUs`, `GetAndResetAvgPingMs`, `LastPingMs`, `SendChatMessage`, `SendAsync`, `GetRemoteBuild`, `ConnectedAtMs`. Move `remote_sent_chat_message_id` behind accessors; change construction/ownership in `Matchmaking::handleConnecting`. This is a larger rewrite because pad queues/timing would otherwise be duplicated.

For backend injection at matchmaking level, virtualize/interface `~Matchmaking`, `FindMatch`, `GetMatchmakeState`, `GetErrorMessage`, `IsSearching`, `GetNetplayClient`, `LocalPlayerIndex`, `GetPlayerInfo`, `GetPlayerName`, `GetStages`, `RemotePlayerCount`, `GetMatchmakeResult` (declarations in `slippi_net.h`). Keep `OnlinePlayMode`/`ProcessState` values stable. `LocalPeer`/`local_peer_ticket` (`slippi_net.cpp:880–915`) demonstrates ticket synthesis without Slippi rendezvous, but **still creates ENet peers**; it is not a WebRTC backend.

## Packet formats, reliability and cadence

Sizes below are **application payload bytes**, excluding ENet/UDP/IP or DataChannel/SCTP/DTLS overhead. They are derived from the serializers in `slippi_net.cpp` and `Packet` in `slippi_net.h`: integers big-endian, boolean one byte, generic string u32 length + bytes. Pads are transmitted newest frame first. `PAD_FULL_SIZE=12` is guest-facing; only `PAD_DATA_SIZE=8` bytes per pad travel in peer PAD messages (`slippi_net.h:23–38,73–79`).

| Message | Exact payload | Bytes | Actual reliability/channel and trigger |
|---|---|---|---|
| `0x80 PAD` | u8 ID; i32 newest frame; u8 player slot; i32 checksum frame; u32 checksum; N × 8 pad bytes | `14 + 8N`; one input = 22 | ENet UNSEQUENCED/channel 1 (`Send:446–450`). Sent per B0 input request when connected, normally one per simulation frame (~60/s); skipped frames resend existing queue; initial delay produces extra packets (`slippi_online.cpp:492–499`) |
| `0x81 PAD_ACK` | u8 ID; i32 newest accepted frame; u8 sender slot | 6 | Actual receive path sends UNSEQUENCED/channel **2** (`OnData:323–328`) only when new frames accepted. Generic `Send` classifies ACK as channel 1, but this ACK branch bypasses it |
| `0x82 MATCH_SELECTIONS` | u8 ID, character, color, selected boolean, player; u16 stage; u8 stage-selected boolean; u32 RNG offset; u8 team; u8 alternate-stage mode | 14 | RELIABLE/channel 0; when `SetMatchSelections` called, including initial connection/menu changes (`:419–429,664–670`) |
| `0x83 CONN_SELECTED` | ID declared; receive handler ignores body | unknown — needs investigation for external format; no local serializer | No local emission found; ignored at `slippi_net.cpp:388` |
| `0x84 CHAT_MESSAGE` | u8 ID; i32 message ID; u8 player slot | 6 | RELIABLE/channel 0; event-driven `SendChatMessage` and chat-disabled response (`:671–692`) |
| `0x85 COMPLETE_STEP`, `0x86 SYNCED_STATE` | IDs declared; handlers intentionally ignore them | unknown — needs investigation for external format; no local serializer | Ranked-only paths are inactive in this build (`OnData:389–390`); no local send cadence |
| `0xE0 MU_BUILD` | u8 ID; ASCII `MUB`; u8 version=1; u8 slot; u8 mod flag; u8 fingerprint length + bytes; u8 name length + bytes | `9 + F + N`, both strings truncated to 64 bytes; retail = 9 | RELIABLE/channel 0; `SendBuild` after connection. Unlike generic Packet strings, lengths here are u8 (`:396–411`) |
| Matchmaking JSON | `create-ticket` / response and `get-ticket-resp` | Variable JSON byte length | RELIABLE/channel 0 to rendezvous; event-driven, receive waits are not peer-pad cadence (`:855–877,965–996`) |

`SendSlippiPad:638–661` retains inputs back to the minimum active-peer ACK, with a floor of newest frame minus 128. Because it deletes frames **strictly less** than the cutoff, a sequential queue can retain 129 samples: `14 + 8×129 = 1046` bytes (derived upper bound for sequential unique input frames, not an MTU guarantee). `OnData:313–321` reconstructs frame numbers, rejects copying more than 128 new inputs, and ignores already received frames. Retransmission is application-level redundancy, not ENet reliable delivery. Exact observed packet rates under loss/rollback and bandwidth distribution are **unknown — needs investigation**; there is no packet capture in this mapping.

Proposed DataChannel mapping: reliable ordered control channel for selections/chat/build/connection metadata; unordered non-retransmitted input and ACK channels, preserving application ACKs and redundant pad history. Keep distinct logical input/ACK channels or tag them explicitly. A browser peer cannot speak these payloads directly to an unchanged ENet Slippi Dolphin socket; a compatible remote transport or gateway would be separate work.

The guest EXI payload is a different format: B0 has **25 bytes**: i32 frame, i32 finalized frame, u32 finalized checksum, u8 delay, 12-byte full pad. B1/B2 have 32-byte payloads; B4 has mode + 18-byte connect-code field; B5 has 9 bytes (`exi_slippi.cpp:56–57`, `slippi_online.cpp:463–469,533–540,623–631`). Never substitute the 8-byte peer pad size for the full B0 payload.

## Transport

The two seams the browser build puts in place of ENet over UDP: `web/src/net/transport.ts` (the interface the netcode is written against, with one unreliable and one reliable path) and `web/src/net/webrtc.ts` (the `RTCPeerConnection` implementation of it: one `game` channel `{ordered:false, maxRetransmits:0}` and one `control` channel `{ordered:true}`).

Between those data channels and the WASM netcode thread, `docs/SPEC_PIANO.md` line 215 puts two single-producer/single-consumer rings over `SharedArrayBuffer`, one per direction, so that neither side ever waits on the other. The layout is implemented twice -- `web/src/net/sab_ring.ts` and `wasm/net/sab_ring.h` -- and this is the definition both follow. Every field is little-endian, which is WASM memory order:

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | `head`: byte offset of the next write, in `[0, capacity)`; producer-owned |
| 4 | 4 | `tail`: byte offset of the next read, in `[0, capacity)`; consumer-owned |
| 8 | 4 | `capacity`: bytes of the data region, a power of two; written once at setup |
| 12 | 4 | `refused`: frames the producer did not enqueue for lack of space |
| 16 | `capacity` | data region |

A frame in the data region is `[u32 payload length][u8 lane][payload]`, so a frame occupies `5 + length` bytes:

| Lane | Meaning | ENet channel it mirrors |
|---|---|---|
| 0 | reliable, ordered | channel 0 (`slippi_net.cpp:450-452`) |
| 1 | unreliable, unordered | channel 1 for pads and channel 2 for pad ACKs (`slippi_net.cpp:450-452,326`) |

The rules both implementations follow, each for a reason:

- `capacity` is a power of two, so the wrap arithmetic is a mask rather than a division.
- One byte is left unused: a frame is written only when `used + size < capacity`, so `head == tail` means "empty" without ambiguity and the ring can never look empty while it is full.
- A frame may wrap the end of the data region. The producer writes it as at most two segments and publishes `head` only after both; the consumer copies the payload out and publishes `tail` only after that. A consumer that loads `head` therefore never sees half a frame.
- A zero-byte payload, a payload above `SAB_RING_MAX_FRAME_BYTES` (1024) and a lane outside one byte are not frames: the writer refuses them without touching the ring and without counting them as back-pressure. The maximum is a rejection threshold, not a design limit: the largest message in the table above is a few hundred bytes.
- The producer never waits. A frame that does not fit is refused (`false` in TypeScript, `SAB_RING_FULL` in C) and the netcode drops the input packet, which is what rollback expects. `refused` counts exactly those.
- The producer publishes with release semantics (`Atomics.store` in TypeScript, `__atomic_store_n` in C) and the consumer loads with acquire, so the payload writes happen-before the index that publishes them. Without threads the header's accessors fall back to plain accesses.
- The notify that wakes a waiting consumer is deliberately not part of the layout: the TypeScript side does its half with `Atomics.notify` on the `head` slot, and a threaded Emscripten build would use `emscripten_atomic_notify` from `<emscripten/threading.h>`.

Two implementations of one layout diverge silently, so the agreement is a test and not a comment. `wasm/net/check_sab_ring.mjs` has both halves write the same scripted sequence into a ring and requires the two ring images to be identical byte for byte, then has each half read the other's image back; it runs in `wasm-probe.yml`, "The ring's layout is one definition". The sequence exercises a frame that wraps, a ring that fills, and the three writes that are not frames. The acceptance criteria `docs/PLAN_BREAKDOWN.md` T7 states for the TypeScript half are in `web/tests/unit/sab_ring.test.ts`.

Not measured, and not claimed: the ring under two real threads. The module is built `MELEE_SINGLE_THREAD=1` (`wasm/core/CMakeLists.txt`), so no worker and no second thread exists to produce or consume these rings yet, and no game frame has crossed one. The C half is compiled single-threaded for the layout test and with `-pthread` (compile only) for the atomic branch; what is missing is a run with two threads on one ring.

## Stock Slippi services and browser disable points

| Service / operation | Implementation and transmitted data | Initial browser-build disposition |
|---|---|---|
| ENet rendezvous `mm.slippi.gg:43113` | `slippi_net.cpp:918–996`: random bound port 41000–50999 unless forced; create-ticket includes uid/playKey/connectCode/displayName, mode/target-code byte array, appVersion, LAN address; parses players/matchId/isHost/stages/items | Disable stock rendezvous. Replace with browser session/signaling backend that supplies equivalent match metadata plus WebRTC peers |
| User API `https://users.slippi.gg/user/<uid>` | `User::RefreshFromServer`, `slippi_net.cpp:153–182`, through `report::http_get`; refreshes display name/code/version/chat messages | Disable in isolated browser build; future fetch/auth/CORS support is unknown — needs investigation |
| GraphQL `https://internal.slippi.gg/graphql` | `slippi_report.cpp:27,88–97,174–194`: `reportOnlineGame`; sends uid/playKey, ISO hash, match/mode/game metadata, player stats | Disable reporter initialization/enqueue path for browser sessions. Do not send synthetic browser tickets to stock reporting |
| Replay upload URL returned by GraphQL | `slippi_report.cpp:163–170,188–190`: HTTP PUT, stored-block gzip, content-type/octet-stream, content-encoding gzip, X-Goog size-range header | Disable along with reporting; local replay download/persistence can remain |
| Local Launcher identity/login | `User::AttemptLogin`, `slippi_online.cpp:1115+`, `prepare_online_status:950–960`; B6 logs native login instructions; `port/app/launcher.cpp:1284` opens Slippi download website | Replace identity source with browser session identity; do not assume access to native Launcher files |
| Ranked operations | `Matchmaking::OnlinePlayMode` retains value 0; online policy rejects unsupported mode; `0x85/0x86` ignored and rank response fields zero | Keep disabled. Older `PORT_COMPLETION.md` rank-fetch/reportMatchStatus claims are historical; current `slippi_report.cpp` implements game reporting, not those older features |
| Desktop launcher lobby / Discord / updater | `port/app/launcher_lobby_p2p.cpp` (DHT + encrypted direct messages), `host/discord_presence.cpp` (local named pipes), `host/updater.cpp` (GitHub) | Exclude these native integrations; they are separate from Slippi server matchmaking, not hidden alternate browser transports |

WinHTTP surface is `WinHttpCrackUrl/Open/SetTimeouts/Connect/OpenRequest/SendRequest/ReceiveResponse/QueryHeaders/QueryDataAvailable/ReadData/CloseHandle` (`slippi_report.cpp:44–80`). ISO MD5 uses `BCryptOpenAlgorithmProvider/CreateHash/HashData/FinishHash/DestroyHash/CloseAlgorithmProvider` (`:127–145`). Fetch is a proposed HTTP replacement, not evidence that Slippi permits cross-origin browser requests. Simply setting `Matchmaking::server_allowed=false` blocks search (`slippi_net.cpp:799–808`), but does not by itself remove user refresh/reporting; gate those separately.

## Time synchronization, rollback and checksums

| Mechanism | Source / behavior |
|---|---|
| Clock estimates | `NetplayClient::OnData` records remote frame timing and local arrival, estimates offset using frame distance and half measured ping (`slippi_net.cpp:300–315`). ACK handler updates RTT from frame send timers (`:332–348`). `CalcTimeOffsetUs:765–783` sorts samples, averages the middle third and returns the minimum active-peer offset |
| Frame availability/window | `ROLLBACK_MAX_FRAMES=7`, `ONLINE_LOCKSTEP_INTERVAL=30` (`slippi_net.h:23–24`). `should_skip_online_frame` (`slippi_online.cpp:304–341`) waits when remote inputs cannot support the rollback window; after more than `60*7` stalled calls it force-disconnects that player |
| Ahead-of-peer sync | Every 30 frames, skip threshold is 10,000 µs during first 120 frames, then `2*16683+10000`; at most 5 initial skips or 1 later (`:326–338`) |
| Behind-peer sync | `should_advance_online_frame:349–378`: host emulation-speed adjustment up to +1% / −0.5%; advance threshold `16683+10000` µs behind; max 3 after frame 120, one advance opportunity every fifth frame; suppressed for opponent runahead |
| Input delay/resend | `handle_online_inputs:463–499` uses payload delay, queues neutral initial delayed frames, sends frame+delay, resends existing input on skip, returns remote inputs and synchronization result |
| Rollback storage | `Savestate:58–123` copies selected RAM intervals, not `ppc::Context`/all RAM/ARAM. Regions: `80005520–80005940`, `803b7240–804DEC00`, `8065c000–8071b000`, and heap bounds read at `804d76b8/804d76bc`. Excludes explicit sound/VI/etc. address ranges; load preserves request-specified blocks and marks restored RAM writes |
| Capture/load control | Guest Slippi code issues B1/B2. `handle_capture_savestate:502–512` takes/recycles a seven-state pool; `handle_load_savestate:514–529` reads frame + address/length preservation pairs, loads, increments rollback counter, marks graphics discontinuity and recycles states. Host does not independently decide all guest prediction/resimulation steps |
| Source-port alternative | `native_savestate.*`, `native_state_layout.h`, `native_slippi_bridge.h`; separate native memory regions/write-watch path. Not the static recomp snapshot mechanism |
| Oracle input | `handle_online_inputs:465–491` reads guest-provided finalized-frame checksum; caches only positive finalized frames with nonzero checksum, at most 600 entries. Exact guest checksum algorithm/covered fields: **unknown — needs investigation** in the Slippi code set; this C++ path does not calculate it |
| Oracle transport | `SendSlippiPad:651–653` includes newest local checksum frame/value; receiver stores per-peer latest checksum in `remote_checksums_`, surfaced by `GetSlippiRemotePad` |
| Oracle compare/log | `prepare_opponent_inputs:396–403` compares each remote's new, nonzero checksum against matching local frame when available; increments counters; logs `slippi: DESYNC: checksum mismatch at frame ...`; every 20 comparisons logs agreement. It is diagnostic, not an automatic disconnect/recovery algorithm |

Do not equate “no DESYNC log” with all frames proven equal: zero checksums, unavailable matching local frames and checksums skipped between received packets do not produce comparisons. Preserve the oracle while changing transport and PPC float helpers. It is separate from host CPU/RAM/ARAM/event checkpoint traces used by `tools/validate_native.py:43–73`. Replay comparisons (`tools/replay_compare.py`, `tools/slp_diff.py`) are an additional, different oracle.

## What the in-game menu requires from replacement matchmaking

The menu communicates through EXI, not through ENet directly. Retain `online::handle`/reply encoding and replace its `User`/`Matchmaking`/peer providers.

1. **Identity and status:** B9 must return logged-in/application-state byte plus game-encoded display name and connect code (`prepare_online_status:950–960`). Browser identity needs a deliberate adapter; synthetic `user.json` filesystem discovery is not required. B6/B7 must have defined login/logout behavior.
2. **Search:** B4 is mode + 18-byte connect-code payload (`start_find_match:533–565`). Modes retained by native schema: Unranked=1, Direct=2, Teams=3, Party=4; Ranked=0 remains unsupported. Search must yield `IDLE=0`, `INITIALIZING=1`, `MATCHMAKING=2`, `OPPONENT_CONNECTING=3`, `CONNECTION_SUCCESS=4`, `ERROR_ENCOUNTERED=5` in that enum order (`slippi_net.h`, `Matchmaking`). Errors must flow to the reply, not remain pending forever.
3. **Ticket/session:** Supply match ID; 2–4 players with uid/displayName/connectCode/port/chat messages/isBot; local index; host/decider; allowed stages/items. Existing parser converts 1-based ticket `port` to zero-based player index and chooses LAN/external address (`ingest_ticket:1000–1051`). Browser implementation replaces address selection with stable session/peer IDs while preserving slot/decider assignment.
4. **Peer establishment and handoff:** `handleConnecting:1055–1095` constructs/polls client, then publishes success. `prepare_online_match_state:721–752` moves ownership from `GetNetplayClient`, obtains result/stages, sends selections, and checks connection plus active-player count. A ticket alone is insufficient; channels must be usable and per-player connectivity available.
5. **Readiness and game setup:** B5 updates character/color/team/stage/alternate mode plus RNG offset (`:623–642`); peers exchange selections. B3 is polled each menu frame (`:687–694`), returning process state, local/remote ready, local/remote index (`:721,778–783`), RNG, delay, chat/rank placeholders, names/codes/uids, error string, game-info block, match ID and alternate stage mode (`:913–947`). Keep `convert_string_for_game`/Shift-JIS formatting and fixed widths: player names use length 15, uid 29 bytes, error length 120, match ID 51 bytes. Exact byte-offset layout should be derived from the serializer, not a new JSON reply.
6. **Validation/cleanup:** Retain stage/character validation and `build_verdict` (`:647–685,824–848`), decider RNG selection (`:850`), mode/team/item rules, Direct-code history/chat and cleanup command. Native `native_poll_match` is explicitly side-effecting and intended at most once per 60 Hz tick (`slippi_online.h`); do not poll it in a browser render loop at display refresh.

The narrowest browser insertion is below online EXI encoding and above ENet lifecycle, with a second replacement at matchmaking/identity. Stock Slippi-server compatibility, browser-to-Dolphin gateway behavior, signaling service design, CORS/auth support and end-to-end determinism remain **unknown — needs investigation**.
