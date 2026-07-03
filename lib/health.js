function formatDuration(totalSeconds) {
  const safeSeconds = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(" ");
}

function summarizeSystemHealth(options = {}) {
  const uptimeSeconds = Math.floor(((Number(options.uptimeMs) || 0) / 1000) % 8640000);
  const connectedPlayers = Math.max(0, Number(options.connectedPlayers) || 0);
  const playlistCount = Math.max(0, Number(options.playlistCount) || 0);
  const mediaCount = Math.max(0, Number(options.mediaCount) || 0);
  const playlistVersion = Math.max(0, Number(options.playlistVersion) || 0);
  const paused = Boolean(options.paused);
  const lastReloadReason = options.lastReloadReason || "startup";

  return {
    ok: true,
    status: paused ? "paused" : "running",
    uptimeSeconds,
    uptimeText: formatDuration(uptimeSeconds),
    mediaCount,
    playlistCount,
    connectedPlayers,
    playlistVersion,
    paused,
    lastReloadReason,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  formatDuration,
  summarizeSystemHealth,
};
