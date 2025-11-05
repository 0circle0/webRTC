# WebRTC SFU Server

A Node.js WebSocket signaling server wired to a mediasoup SFU. The server enforces a
“two publishers, many observers” room model and exposes administrative HTTP endpoints
for monitoring. A minimal browser UI is included for manual testing.

## Features

- mediasoup-based SFU with automatic worker creation (SFU is mandatory)
- JSON WebSocket signaling with room membership, role enforcement, and admin actions
- Optional token auth (`ENABLE_AUTH=1`) with file-backed demo token storage
- Monitoring endpoints (`/admin/rooms`, `/admin/room/:name`, `/admin/metrics`)
- Standalone MVP UI (`ui/index.html`) to join a room and publish/subscribe to video

## Prerequisites

- Node.js 18+ (mediasoup builds against the active Node toolchain)
- Python 3.x, C/C++ build tools (required for mediasoup native dependencies)

On Windows install the _Desktop development with C++_ workload via Visual Studio
Build Tools before running `yarn install`.

## Installation

```bash
yarn install
```

The install step compiles mediasoup; expect a few minutes on first run.

## Running the stack

1. **Start the signaling + SFU server**

   ```bash
   yarn start
   ```

   - WebSocket signaling: `ws://0.0.0.0:${PORT || 3000}`
   - Admin HTTP API: `http://0.0.0.0:${ADMIN_PORT || PORT + 1}`

2. **Serve the browser MVP**

   ```bash
   yarn ui
   ```

   Visit `http://localhost:${UI_PORT || 4000}` and join a room. The page captures
   camera/microphone, creates mediasoup send/receive transports, and plays back any
   remote producers in the room.

3. **(Optional) Enable auth**

   Tokens live in `data/tokens.json`. A demo token `demo-token` is seeded on first run.
   Start the server with `ENABLE_AUTH=1` and append `?token=<value>` to the WebSocket URL
   (or use the UI token field) to authenticate. Admin HTTP requests require a user with
   `{ "role": "admin" }` in `tokens.json`.

## Configuration

All settings are handled via environment variables:

| Variable                                                   | Description                                        |
| ---------------------------------------------------------- | -------------------------------------------------- |
| `PORT`                                                     | WebSocket listener (default `3000`)                |
| `ADMIN_PORT`                                               | Admin HTTP port (default `PORT + 1`)               |
| `ENABLE_AUTH`                                              | Require tokens when set to `1`                     |
| `ICE_SERVERS`                                              | JSON array passed to clients (overrides defaults)  |
| `TURN_HOST`, `TURN_PORT`, `TURN_USERNAME`, `TURN_PASSWORD` | Convenience TURN builder                           |
| `PUBLIC_IP`                                                | Public IP advertised in SFU listen IPs             |
| `SFU_LISTEN_IPS`                                           | JSON array of `{ ip, announcedIp }` objects        |
| `MAX_VIDEO_PER_ROOM`                                       | Limit video producers per room (default `2`)       |
| `MAX_OBSERVERS`                                            | Limit observers per room (default `0` = unlimited) |

## Admin API

All endpoints require an admin token (bearer header or `?token=...`).

- `GET /admin/rooms` – summary of active rooms and SFU totals
- `GET /admin/room/:name` – detailed membership + roles for a specific room
- `GET /admin/metrics` – mediasoup transport/producer/consumer counts per room

## Development tips

- `yarn start:dev` runs the server with nodemon for hot reloads.
- `yarn start:withauth` and `yarn start:withoutauth` toggle auth enforcement.
- UI tweaks live under `ui/` and are served by `scripts/ui-server.js`.

## License

MIT
