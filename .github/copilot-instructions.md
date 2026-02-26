## Purpose
Short guidance for AI coding agents to be immediately productive in this repo.

## Big picture
- Node/Express app (`server.js`) serves a static web UI from `public/` and exposes a small API at `/api/playlist`.
- Media files live in `public/media/`; the server returns a playlist (images/videos) built from that directory.
- Real-time notifications use Socket.IO: agents should look for the `reload` event (emitted server-side and from the admin UI).
- File-system changes are watched by `chokidar` which triggers `io.emit('reload')` so players re-fetch `/api/playlist`.

## Key files (quick links)
- [server.js](server.js#L1-L200) — main HTTP + Socket.IO server and playlist generation.
- [package.json](package.json#L1-L50) — start script and runtime deps (`express`, `socket.io`, `chokidar`).
- [Dockerfile](Dockerfile#L1-L40) — container image (node:20-alpine) and `npm start` entrypoint.
- [docker-compose.yml](docker-compose.yml#L1-L40) — convenient development compose with `./public/media` volume and CHOKIDAR envs.
- [public/player.html](public/player.html#L1-L200) — player behavior: fetches `/api/playlist`, plays images/videos, listens for `reload`.
- [public/admin.html](public/admin.html#L1-L200) — admin UI: triggers reload via Socket.IO.

## Runtime & developer workflows
- Local start: `npm start` (uses `node server.js`, listens on port 3000).
- Docker (build + run):
  - `docker build -t office-signage .` then
  - `docker run -p 3000:3000 -v $(pwd)/public/media:/app/public/media office-signage`
- With Compose: `docker-compose up --build` (compose mounts `./public/media` and sets `CHOKIDAR_USEPOLLING`/`CHOKIDAR_INTERVAL`).
- Debugging: check server console logs for connections and chokidar messages; player/admin sockets log in browser console.

## Project-specific patterns & notes
- Playlist generation is synchronous (`fs.readdirSync`) and files are alphabetically sorted — changes to ordering should modify the sort call in `server.js`.
- Supported media: images (`.jpg,.jpeg,.png,.gif,.webp`) and videos (`.mp4,.webm,.mov`) — see server-side extension sets.
- Images default to 7000ms (`duration: 7000`) unless modified in `server.js` mapping.
- Filenames are served via `encodeURIComponent(name)` — expect URL-encoded names in `/media/<name>`.
- The player relies on `video.autoplay` + `muted` for autoplay to work across browsers.

## Integration points & external dependencies
- Socket.IO: used for simple pub/sub reload notifications (`reload` event).
- Chokidar: watches `public/media` and triggers reloads; in containerized/dev environments the compose file sets polling env vars to ensure file change detection works on Docker Desktop.

## Common edits an agent may be asked to perform (how to make changes safely)
- To change image display duration: update the `duration` value in the mapping inside `server.js` (search for `duration: 7000`).
- To add new file types: update the `imageExt` / `videoExt` sets in `server.js` and ensure player handles them.
- To change reload behavior: edit `chokidar.watch(...)` or the socket event name in both `server.js` and `public/*` pages.

## Quick examples
- Force reload from admin UI: open `/admin` and click "Reload all screens".
- Manually trigger reload via socket.io client: `socket.emit('reload')` from any connected client.

## What to avoid
- Do not replace synchronous `readdirSync` with heavy blocking logic without considering small media folder assumptions.

## When you need clarification
- If a change touches playlist timing, autoplay behavior, or large media folders, ask whether media will be hosted remotely or kept in `public/media/`.

---
If anything here is unclear or you want the agent instructions to include more examples (tests, CI, or contributor conventions), tell me what to expand.
