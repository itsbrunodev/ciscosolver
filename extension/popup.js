const DEFAULTS = {
  SERVER_URL: "https://assets.valec.link",
  CHECK_INTERVAL: 1000,
  MARKER_SIZE: 2,
  MARKER_COLOR: "#d0d7e1",
  CANDIDATE_COUNT: 30,
  DEBUG: false,
  MIN_QUESTION_SIMILARITY: 0.45,
  MIN_ANSWER_SIMILARITY: 0.6,
};

const views = {
  main: document.getElementById("view-main"),
  settings: document.getElementById("view-settings"),
  about: document.getElementById("view-about"),
  health: document.getElementById("view-health"),
};

const inputs = {
  SERVER_URL: document.getElementById("SERVER_URL"),
  CHECK_INTERVAL: document.getElementById("CHECK_INTERVAL"),
  MARKER_SIZE: document.getElementById("MARKER_SIZE"),
  MARKER_COLOR: document.getElementById("MARKER_COLOR"),
  CANDIDATE_COUNT: document.getElementById("CANDIDATE_COUNT"),
  MIN_QUESTION_SIMILARITY: document.getElementById("MIN_QUESTION_SIMILARITY"),
  MIN_ANSWER_SIMILARITY: document.getElementById("MIN_ANSWER_SIMILARITY"),
};

const btnLight = document.getElementById("btn-light");
const btnDark = document.getElementById("btn-dark");
const btnDebugOn = document.getElementById("btn-debug-on");
const btnDebugOff = document.getElementById("btn-debug-off");

function applyDebugUI(isDebug) {
  if (isDebug) {
    btnDebugOn.classList.add("active");
    btnDebugOff.classList.remove("active");
  } else {
    btnDebugOff.classList.add("active");
    btnDebugOn.classList.remove("active");
  }
}

function applyTheme(theme) {
  if (theme === "dark") {
    document.body.classList.add("dark");
    btnDark.classList.add("active");
    btnLight.classList.remove("active");
  } else {
    document.body.classList.remove("dark");
    btnLight.classList.add("active");
    btnDark.classList.remove("active");
  }
}

chrome.storage.sync.get(["theme"], (data) => {
  applyTheme(data.theme || "light");
});

if (btnLight && btnDark) {
  btnLight.onclick = () => {
    applyTheme("light");
    chrome.storage.sync.set({ theme: "light" });
  };
  btnDark.onclick = () => {
    applyTheme("dark");
    chrome.storage.sync.set({ theme: "dark" });
  };
}

let healthInterval = null;

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

async function updateHealthDisplay() {
  const errorBanner = document.getElementById("health-error");
  const healthData = document.getElementById("health-data");

  try {
    const currentUrlVal = document.getElementById("SERVER_URL").value;
    const baseUrl = currentUrlVal ? currentUrlVal : DEFAULTS.SERVER_URL;
    const url = new URL(baseUrl).origin;

    const res = await fetch(`${url}/health`, { method: "GET" });
    const data = await res.json();

    // Hide error, show data
    errorBanner.style.display = "none";
    healthData.style.display = "block";

    // Update values
    document.getElementById("health-status").textContent =
      data.status === "ok" ? "Online" : "Offline";
    document.getElementById("health-status").style.color =
      data.status === "ok" ? "hsl(142.1 76.2% 36.3%)" : "hsl(0 84.2% 60.2%)";
    document.getElementById("health-uptime").textContent = formatUptime(
      data.uptime,
    );
    document.getElementById("health-cpu").textContent = data.cpuUsage || "0%";
    document.getElementById("health-ram").textContent =
      data.memory.rss || "0MB";
    document.getElementById("health-active").textContent =
      data.activeRequests || 0;
    document.getElementById("health-total").textContent =
      data.totalRequests || 0;
    document.getElementById("health-running").textContent =
      data.queueStats?.running || 0;
    document.getElementById("health-queued").textContent =
      data.queueStats?.queued || 0;
    document.getElementById("health-max-concurrent").textContent =
      data.queueStats?.maxConcurrent || 0;
    document.getElementById("health-cache").textContent = data.cacheSize || 0;
    document.getElementById("health-last-update").textContent =
      new Date().toLocaleTimeString();
    document.getElementById("health-worker-id").textContent =
      data.worker || "-";
  } catch (e) {
    // Show error, hide data
    errorBanner.style.display = "block";
    healthData.style.display = "none";
  }
}

function startHealthMonitoring() {
  // Clear any existing interval
  if (healthInterval) clearInterval(healthInterval);

  // Update immediately
  updateHealthDisplay();

  // Then update every 5 seconds
  healthInterval = setInterval(updateHealthDisplay, 1000);
}

function stopHealthMonitoring() {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}

// --- Navigation ---
function showView(name) {
  Object.values(views).forEach((v) => v.classList.add("hidden"));
  views[name].classList.remove("hidden");

  // Start/stop health monitoring based on view
  if (name === "health") {
    startHealthMonitoring();
  } else {
    stopHealthMonitoring();
  }
}

document.getElementById("go-about").onclick = () => showView("about");
document.getElementById("go-health").onclick = () => showView("health");
document.getElementById("go-settings").onclick = () => showView("settings");
document
  .querySelectorAll(".go-back")
  .forEach((b) => (b.onclick = () => showView("main")));

// --- Health Check ---
async function checkHealth() {
  const status = document.getElementById("status-indicator");
  try {
    // Use current input value if user is typing, otherwise fallback to storage/defaults
    const currentUrlVal = document.getElementById("SERVER_URL").value;
    const baseUrl = currentUrlVal ? currentUrlVal : DEFAULTS.SERVER_URL;

    const url = new URL(baseUrl).origin;

    // Simple GET to root
    const res = await fetch(`${url}/`, { method: "GET" });
    const isOk = await res
      .json()
      .then((res) => res.status === "ok")
      .catch(() => false); // Expecting true/false or similar truthy

    status.className = `status-badge ${isOk ? "online" : "offline"}`;
    status.innerHTML = `<div class="status-dot"></div>${isOk ? "Online" : "Offline"}`;
  } catch (e) {
    status.className = "status-badge offline";
    status.innerHTML = `<div class="status-dot"></div>Offline`;
  }
}

// Run check periodically
setInterval(checkHealth, 5000);

// --- Settings Loading ---
const fields = Object.keys(DEFAULTS);
const hexDisplay = document.getElementById("MARKER_COLOR_HEX");

chrome.storage.sync.get(fields, (data) => {
  fields.forEach((f) => {
    const val = data[f] ?? DEFAULTS[f];
    if (inputs[f]) inputs[f].value = val;
  });

  // applyTheme(data.theme || "light");
  applyDebugUI(data.DEBUG ?? DEFAULTS.DEBUG);

  // Update Hex Display on load
  if (hexDisplay && inputs.MARKER_COLOR) {
    hexDisplay.textContent = inputs.MARKER_COLOR.value;
  }

  // Run health check immediately after loading the URL
  checkHealth();
});

btnDebugOn.onclick = () => applyDebugUI(true);
btnDebugOff.onclick = () => applyDebugUI(false);

// Update Hex text when color picker changes
if (inputs.MARKER_COLOR && hexDisplay) {
  inputs.MARKER_COLOR.addEventListener("input", (e) => {
    hexDisplay.textContent = e.target.value;
  });
}

// --- Save Logic ---
// --- Save Logic ---
document.getElementById("save").onclick = () => {
  const config = {};

  // Save all input fields (use the inputs object which excludes DEBUG)
  Object.keys(inputs).forEach((f) => {
    if (inputs[f]) {
      if (inputs[f].type === "number") {
        config[f] = Number.parseFloat(inputs[f].value);
      } else {
        config[f] = inputs[f].value;
      }
    }
  });

  // Handle DEBUG separately (it's managed by buttons, not an input)
  config.DEBUG = btnDebugOn.classList.contains("active");

  // console.log("Saving config:", config); // Debug log

  chrome.storage.sync.set(config, () => {
    // console.log("Config saved to storage"); // Debug log

    // Show saved indicator
    const indicator = document.getElementById("save-indicator");
    if (indicator) {
      indicator.classList.add("show");
      setTimeout(() => indicator.classList.remove("show"), 2000);
    }

    // Notify Content Script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "updateConfig", config });
        // console.log("Config sent to content script"); // Debug log
      }
    });
  });
};

// --- Reset Logic ---
document.getElementById("reset").onclick = () => {
  fields.forEach((f) => {
    if (inputs[f]) {
      inputs[f].value = DEFAULTS[f];
      if (f === "MARKER_COLOR") inputs[f].dispatchEvent(new Event("input"));
      if (f === "DEBUG") applyDebugUI(DEFAULTS[f]);
    }
  });
};
