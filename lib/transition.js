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

function normalizeTransitionMode(value, fallback = "fade") {
  const normalized = String(value || "").trim().toLowerCase();
  if (["fade", "page", "slide", "none"].includes(normalized)) return normalized;
  return normalizeTransitionEnabled(value, fallback !== "none") ? fallback : "none";
}

function getTransitionMode(settings = {}, fallback = "fade") {
  if (settings.transitionMode) {
    return normalizeTransitionMode(settings.transitionMode, fallback);
  }

  if (Object.prototype.hasOwnProperty.call(settings, "fadeEnabled")) {
    return settings.fadeEnabled === false ? "none" : fallback;
  }

  if (Object.prototype.hasOwnProperty.call(settings, "imageTransitionEnabled")) {
    return normalizeTransitionEnabled(settings.imageTransitionEnabled, fallback !== "none") ? fallback : "none";
  }

  return normalizeTransitionMode(fallback, "fade");
}

function getImageTransitionEnabled(settings, fallback = false) {
  return getTransitionMode(settings, fallback ? "fade" : "none") !== "none";
}

function getPlayerSettingsPayload(settings = {}, fallback = "fade") {
  const transitionMode = getTransitionMode(settings, fallback);
  return {
    transitionMode,
    fadeEnabled: transitionMode !== "none",
    imageTransitionEnabled: transitionMode !== "none",
  };
}

module.exports = {
  normalizeTransitionEnabled,
  normalizeTransitionMode,
  getTransitionMode,
  getImageTransitionEnabled,
  getPlayerSettingsPayload,
};
