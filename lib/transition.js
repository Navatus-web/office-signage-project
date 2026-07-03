function normalizeTransitionEnabled(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  }

  return Boolean(fallback);
}

function getImageTransitionEnabled(settings, fallback = false) {
  return normalizeTransitionEnabled(settings?.imageTransitionEnabled, fallback);
}

function getPlayerSettingsPayload(settings = {}, fallback = false) {
  return {
    imageTransitionEnabled: getImageTransitionEnabled(settings, fallback),
  };
}

module.exports = {
  normalizeTransitionEnabled,
  getImageTransitionEnabled,
  getPlayerSettingsPayload,
};
