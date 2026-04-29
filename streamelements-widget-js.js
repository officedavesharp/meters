const WOW_CLASS_COLORS = {
  DEATHKNIGHT: "#C41E3A",
  DEMONHUNTER: "#A330C9",
  DRUID: "#FF7C0A",
  HUNTER: "#AAD372",
  MAGE: "#3FC7EB",
  MONK: "#00FF98",
  PALADIN: "#F48CBA",
  PRIEST: "#FFFFFF",
  ROGUE: "#FFF468",
  SHAMAN: "#0070DD",
  WARLOCK: "#8788EE",
  WARRIOR: "#C69B6D"
};
const PLAYABLE_WOW_CLASSES = Object.keys(WOW_CLASS_COLORS);

/**
 * Texture coordinates copied from Details class coordinates for the
 * classes_small_alpha atlas. Values are normalized [0..1].
 */
const DETAILS_CLASS_ICON_COORDS = {
  WARRIOR: [0, 0.125, 0, 0.125],
  HUNTER: [0, 0.125, 0.125, 0.25],
  MAGE: [0.125, 0.248046875, 0, 0.125],
  ROGUE: [0.248046875, 0.37109375, 0, 0.125],
  DRUID: [0.37109375, 0.494140625, 0, 0.125],
  WARLOCK: [0.37109375, 0.494140625, 0.125, 0.25],
  PRIEST: [0.248046875, 0.37109375, 0.125, 0.25],
  SHAMAN: [0.125, 0.248046875, 0.125, 0.25],
  PALADIN: [0, 0.125, 0.25, 0.375],
  DEATHKNIGHT: [0.125, 0.25, 0.25, 0.375],
  MONK: [0.25, 0.369140625, 0.25, 0.375],
  DEMONHUNTER: [0.369140625, 0.5, 0.25, 0.375]
};

const config = {
  title: "Chat DPS",
  windowMinutes: 30,
  maxRows: 8,
  showRank: true,
  defaultClass: "WARRIOR",
  classAssignments: {},
  classIconAtlasUrl: "https://raw.githubusercontent.com/officedavesharp/meters/main/assets/classes_small_alpha.png",
  classIconAtlasSize: 256
};

const meterStore = new Map();
let renderIntervalId = null;

function safeJsonParse(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeClassName(className) {
  if (!className || typeof className !== "string") return config.defaultClass;
  const normalized = className.trim().toUpperCase();
  return WOW_CLASS_COLORS[normalized] ? normalized : config.defaultClass;
}

function getViewerClass(viewerName) {
  const classMapKey = String(viewerName || "").toLowerCase();
  const assigned = config.classAssignments[classMapKey];

  /**
   * If there is no manual assignment for this viewer, assign a random class
   * once and keep it in memory for the session so it remains stable.
   */
  if (!assigned) {
    const randomClass =
      PLAYABLE_WOW_CLASSES[Math.floor(Math.random() * PLAYABLE_WOW_CLASSES.length)] ||
      config.defaultClass;
    config.classAssignments[classMapKey] = randomClass;
    return normalizeClassName(randomClass);
  }

  return normalizeClassName(assigned);
}

function trimOldEvents(entry) {
  const now = Date.now();
  const windowMs = config.windowMinutes * 60 * 1000;
  entry.events = entry.events.filter((ts) => now - ts <= windowMs);
}

function registerMessage(viewerName, amount, timestampMs) {
  const key = String(viewerName || "Unknown").toLowerCase();
  const displayName = String(viewerName || "Unknown");
  const safeAmount = Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 1;
  const eventTs = Number.isFinite(timestampMs) ? timestampMs : Date.now();

  if (!meterStore.has(key)) {
    meterStore.set(key, {
      viewerName: displayName,
      wowClass: getViewerClass(displayName),
      totalMessages: 0,
      events: []
    });
  }

  const entry = meterStore.get(key);
  entry.totalMessages += safeAmount;
  for (let i = 0; i < safeAmount; i += 1) entry.events.push(eventTs);
  trimOldEvents(entry);
}

function getSortedRows() {
  const rows = [];
  meterStore.forEach((entry) => {
    trimOldEvents(entry);
    const recentMessages = entry.events.length;

    /**
     * Meter should only display active rows inside the rolling window.
     * This prevents stale historical rows (e.g. 0 recent) from lingering.
     */
    if (recentMessages <= 0) {
      return;
    }

    rows.push({
      viewerName: entry.viewerName,
      wowClass: normalizeClassName(entry.wowClass),
      recentMessages,
      totalMessages: entry.totalMessages
    });
  });

  rows.sort((a, b) => {
    if (b.recentMessages !== a.recentMessages) return b.recentMessages - a.recentMessages;
    if (b.totalMessages !== a.totalMessages) return b.totalMessages - a.totalMessages;
    return a.viewerName.localeCompare(b.viewerName);
  });

  return rows.slice(0, config.maxRows);
}

/**
 * Convert numbers to compact display format.
 * Examples:
 * 999 -> 999
 * 1100 -> 1.1k
 * 10000 -> 10k
 * 100000 -> 100k
 * 1000000 -> 1M
 */
function formatCompactCount(value) {
  const num = Number(value) || 0;

  if (num < 1000) {
    return String(Math.floor(num));
  }

  if (num < 1000000) {
    const thousands = num / 1000;
    if (thousands < 10) {
      return `${thousands.toFixed(1).replace(/\.0$/, "")}k`;
    }
    return `${Math.round(thousands)}k`;
  }

  const millions = num / 1000000;
  if (millions < 10) {
    return `${millions.toFixed(1).replace(/\.0$/, "")}M`;
  }
  return `${Math.round(millions)}M`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Gift events can include both gifter and recipient data. We must attribute
 * the meter row to the gifter only. If no gifter identity exists on a gift
 * payload, we skip the event to avoid incorrectly counting recipients.
 */
function resolveActorName(event, isGiftEvent) {
  const gifterName =
    event?.gifter ||
    event?.gifterName ||
    event?.gifterDisplayName ||
    event?.gifter_username ||
    event?.gifterUserName ||
    event?.sender ||
    event?.from ||
    event?.fromUser ||
    event?.from_user ||
    event?.user;

  if (isGiftEvent) {
    if (!gifterName) return null;
    return String(gifterName);
  }

  const normalSubscriberName =
    event?.name ||
    event?.username ||
    event?.displayName ||
    event?.sender ||
    event?.user ||
    "Unknown";
  return String(normalSubscriberName);
}

/**
 * Community gift payloads are inconsistent across event sources.
 * This helper checks many known keys (including nested objects) and returns
 * the best detected sub count for a single event.
 */
function resolveSubAmount(event) {
  const directCandidates = [
    event?.bulkGifted,
    event?.gifted,
    event?.gift_amount,
    event?.giftAmount,
    event?.giftCount,
    event?.gifts,
    event?.qty,
    event?.count,
    event?.quantity,
    event?.amount
  ];

  const nestedCandidates = [
    event?.data?.bulkGifted,
    event?.data?.gifted,
    event?.data?.gift_amount,
    event?.data?.giftAmount,
    event?.data?.giftCount,
    event?.data?.gifts,
    event?.data?.qty,
    event?.data?.count,
    event?.data?.quantity,
    event?.data?.amount,
    event?.message?.bulkGifted,
    event?.message?.gifted,
    event?.message?.gift_amount,
    event?.message?.giftAmount,
    event?.message?.giftCount,
    event?.message?.gifts,
    event?.message?.count,
    event?.message?.quantity,
    event?.message?.amount
  ];

  const allCandidates = directCandidates.concat(nestedCandidates);
  for (let i = 0; i < allCandidates.length; i += 1) {
    const parsed = Number(allCandidates[i]);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }

  return 1;
}

/**
 * Resolve a chat sender name from multiple payload variants.
 * StreamElements chat payloads can place user identity at top-level, nested
 * under data/message, or inside IRC-style tags. This helper keeps a strict
 * priority so display names are preferred over raw login names.
 */
function resolveChatActorName(event) {
  const candidates = [
    event?.displayName,
    event?.display_name,
    event?.nick,
    event?.username,
    event?.userName,
    event?.name,
    event?.sender,
    event?.user,
    event?.from,
    event?.author,
    event?.channel,
    event?.data?.displayName,
    event?.data?.display_name,
    event?.data?.nick,
    event?.data?.username,
    event?.data?.userName,
    event?.data?.name,
    event?.data?.sender,
    event?.data?.user,
    event?.data?.from,
    event?.data?.author,
    event?.message?.displayName,
    event?.message?.display_name,
    event?.message?.nick,
    event?.message?.username,
    event?.message?.userName,
    event?.message?.name,
    event?.message?.sender,
    event?.message?.user,
    event?.message?.from,
    event?.message?.author,
    event?.tags?.["display-name"],
    event?.tags?.displayName,
    event?.tags?.username,
    event?.tags?.login,
    event?.data?.tags?.["display-name"],
    event?.data?.tags?.displayName,
    event?.data?.tags?.username,
    event?.data?.tags?.login
  ];

  for (let i = 0; i < candidates.length; i += 1) {
    const raw = candidates[i];
    if (raw === null || raw === undefined) continue;
    const value = String(raw).trim();
    if (value && value.toLowerCase() !== "unknown") return value;
  }

  return "Unknown";
}

function buildMeterRowElement() {
  const rowEl = document.createElement("div");
  rowEl.className = "meter-row";
  rowEl.innerHTML = `
    <div class="meter-row__bar"></div>
    <div class="meter-row__left">
      <div class="meter-row__icon"></div>
      <div class="meter-row__name"></div>
    </div>
    <div class="meter-row__total"></div>
    <div class="meter-row__recent"></div>
  `;
  return rowEl;
}

function updateMeterRowElement(rowEl, rowData, idx, maxRecent) {
  const fillPct = Math.max(0, Math.min(100, (rowData.recentMessages / maxRecent) * 100));
  const color = WOW_CLASS_COLORS[rowData.wowClass] || WOW_CLASS_COLORS[config.defaultClass];
  const coords = DETAILS_CLASS_ICON_COORDS[rowData.wowClass] || DETAILS_CLASS_ICON_COORDS[config.defaultClass];
  const atlasSize = Number(config.classIconAtlasSize) || 256;
  const iconLeft = Math.round((coords?.[0] || 0) * atlasSize);
  const iconTop = Math.round((coords?.[2] || 0) * atlasSize);
  const rankLabel = config.showRank ? `${idx + 1}. ` : "";

  rowEl.dataset.class = rowData.wowClass;
  rowEl.dataset.key = String(rowData.viewerName || "").toLowerCase();

  const barEl = rowEl.querySelector(".meter-row__bar");
  const iconEl = rowEl.querySelector(".meter-row__icon");
  const nameEl = rowEl.querySelector(".meter-row__name");
  const totalEl = rowEl.querySelector(".meter-row__total");
  const recentEl = rowEl.querySelector(".meter-row__recent");

  if (barEl) {
    barEl.style.width = `${fillPct}%`;
    barEl.style.background = `${color}C5`;
  }

  if (iconEl) {
    iconEl.style.backgroundImage = `url('${config.classIconAtlasUrl}')`;
    iconEl.style.backgroundPosition = `-${iconLeft}px -${iconTop}px`;
    iconEl.style.backgroundSize = `${atlasSize}px ${atlasSize}px`;
  }

  if (nameEl) nameEl.textContent = `${rankLabel}${rowData.viewerName}`;
  if (totalEl) totalEl.textContent = formatCompactCount(rowData.totalMessages);
  if (recentEl) recentEl.textContent = String(rowData.recentMessages);
}

function renderMeter() {
  const body = document.getElementById("meterBody");
  const rows = getSortedRows();
  const maxRecent = Math.max(1, ...rows.map((r) => r.recentMessages));

  if (!rows.length) {
    body.innerHTML = "";
    return;
  }

  if (body.querySelector(".meter-empty")) {
    body.innerHTML = "";
  }

  while (body.children.length < rows.length) {
    body.appendChild(buildMeterRowElement());
  }
  while (body.children.length > rows.length) {
    body.removeChild(body.lastElementChild);
  }

  rows.forEach((row, idx) => {
    updateMeterRowElement(body.children[idx], row, idx, maxRecent);
  });
}

function extractMessageEventData(detail) {
  const event = detail?.event || {};
  const listener = (detail?.listener || "").toString().toLowerCase();
  const eventName = (event?.type || event?.event || "").toString().toLowerCase();
  const mergedType = `${listener} ${eventName}`;
  const isLikelyMessageEvent =
    mergedType.includes("message") ||
    mergedType.includes("chat");
  if (!isLikelyMessageEvent) return { isLikelyMessageEvent: false, viewerName: "", amount: 0 };

  const viewerName = resolveChatActorName(event);

  const amount =
    Number(event?.amount) ||
    Number(event?.count) ||
    Number(event?.quantity) ||
    1;

  return { isLikelyMessageEvent, viewerName, amount };
}

/**
 * Accepts a wide range of session event shapes and tries to identify
 * subscriber events from StreamElements bootstrap/session payloads.
 */
function extractMessageEventDataFromSessionEvent(sessionEvent) {
  const event = sessionEvent?.event || sessionEvent || {};
  const listener = (sessionEvent?.listener || sessionEvent?.type || "").toString().toLowerCase();
  const eventName = (event?.type || event?.event || "").toString().toLowerCase();
  const mergedType = `${listener} ${eventName}`;

  const isLikelyMessageEvent =
    mergedType.includes("message") ||
    mergedType.includes("chat");
  if (!isLikelyMessageEvent) return null;

  const viewerName = resolveChatActorName(event);
  if (!viewerName || viewerName === "Unknown") return null;

  const amount =
    Number(event?.amount) ||
    Number(event?.count) ||
    Number(event?.quantity) ||
    1;

  const timestampMs =
    Number(event?.ts) ||
    Number(event?.timestamp) ||
    Number(sessionEvent?.createdAt) ||
    Date.now();

  return { viewerName, amount, timestampMs };
}

/**
 * Tries to bootstrap historical entries from StreamElements session data
 * when available on widget load.
 */
function loadFromSessionData(sessionData) {
  if (!sessionData || typeof sessionData !== "object") return 0;
  let loadedEvents = 0;
  const seen = new Set();

  /**
   * StreamElements session payloads can be deeply nested and inconsistent.
   * We recursively walk objects/arrays and try to normalize every candidate.
   */
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((item) => walk(item));
      return;
    }

    const normalized = extractMessageEventDataFromSessionEvent(node);
    if (normalized) {
      registerMessage(normalized.viewerName, normalized.amount, normalized.timestampMs);
      loadedEvents += 1;
    }

    Object.values(node).forEach((child) => {
      if (child && typeof child === "object") walk(child);
    });
  }

  walk(sessionData);

  return loadedEvents;
}

window.addEventListener("onWidgetLoad", (obj) => {
  const fieldData = obj?.detail?.fieldData || {};
  const sessionData = obj?.detail?.session?.data || {};

  if (fieldData.title) config.title = String(fieldData.title);
  if (fieldData.windowMinutes) config.windowMinutes = Math.max(1, Number(fieldData.windowMinutes) || 30);
  if (fieldData.maxRows) config.maxRows = Math.max(1, Number(fieldData.maxRows) || 8);
  if (fieldData.showRank !== undefined) config.showRank = fieldData.showRank === true || String(fieldData.showRank).toLowerCase() === "true";
  if (fieldData.defaultClass) config.defaultClass = normalizeClassName(fieldData.defaultClass);
  if (fieldData.classIconAtlasUrl) config.classIconAtlasUrl = String(fieldData.classIconAtlasUrl);
  if (fieldData.classIconAtlasSize) config.classIconAtlasSize = Math.max(32, Number(fieldData.classIconAtlasSize) || 256);

  const parsedClassMap = safeJsonParse(fieldData.classAssignmentsJson, {});
  const normalizedMap = {};
  Object.entries(parsedClassMap).forEach(([viewer, wowClass]) => {
    normalizedMap[String(viewer).toLowerCase()] = normalizeClassName(wowClass);
  });
  config.classAssignments = normalizedMap;

  const initialRows = safeJsonParse(fieldData.initialLeaderboardJson, []);
  let loadedSeedRows = 0;
  if (Array.isArray(initialRows)) {
    initialRows.forEach((row) => {
      const name = row?.name || row?.viewerName;
      const recent = Number(row?.recent30m || row?.recent || 0);
      const total = Number(row?.total || 0);
      const wowClass = normalizeClassName(row?.class || row?.wowClass || config.defaultClass);
      if (!name) return;

      const key = String(name).toLowerCase();
      const entry = {
        viewerName: String(name),
        wowClass,
          totalMessages: Number.isFinite(total) && total > 0 ? Math.floor(total) : 0,
        events: []
      };

      const recentCount = Number.isFinite(recent) && recent > 0 ? Math.floor(recent) : 0;
      const now = Date.now();
      for (let i = 0; i < recentCount; i += 1) entry.events.push(now - i * 1000);
      meterStore.set(key, entry);
      loadedSeedRows += 1;
    });
  }

  const loadedSessionEvents = loadFromSessionData(sessionData);
  if (loadedSeedRows > 0 || loadedSessionEvents > 0) {
    console.log(
      `[wow-subs-meter] bootstrap loaded rows=${loadedSeedRows}, sessionEvents=${loadedSessionEvents}`
    );
  } else {
    console.log("[wow-subs-meter] no historical bootstrap data found on widget load");
  }

  renderMeter();

  /**
   * Refresh every second so rolling-window values naturally decay over time
   * even when no new chat events are received.
   */
  if (renderIntervalId) clearInterval(renderIntervalId);
  renderIntervalId = setInterval(() => {
    renderMeter();
  }, 1000);
});

window.addEventListener("onEventReceived", (obj) => {
  const detail = obj?.detail;
  const { isLikelyMessageEvent, viewerName, amount } = extractMessageEventData(detail);
  if (!isLikelyMessageEvent) return;
  registerMessage(viewerName, amount, Date.now());
  renderMeter();
});
