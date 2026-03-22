let CONFIG = {
  CHECK_INTERVAL: 1000,
  SERVER_URL: "https://assets.valec.link",
  MARKER_SIZE: 2,
  MARKER_COLOR: "#d0d7e1",
  CANDIDATE_COUNT: 30,
  MIN_QUESTION_SIMILARITY: 0.45,
  MIN_ANSWER_SIMILARITY: 0.6,
  DEBUG: false,
  SHORTCUTS: {
    toggleMarkers: ["NumpadSubtract", "Ctrl+Alt+V"],
    forceRefetch: ["NumpadAdd", "Ctrl+Alt+R"],
  },
};

let isProcessing = false;
let areMarkersVisible = true;
let monitoringThread = null;
let statusIndicator = null;

document.documentElement.style.setProperty("--cisco-marker-opacity", "1");

chrome.storage.sync.get(Object.keys(CONFIG), (data) => {
  if (data.SHORTCUTS) {
    CONFIG.SHORTCUTS = { ...CONFIG.SHORTCUTS, ...data.SHORTCUTS };
  }
  CONFIG = { ...CONFIG, ...data };
  console.log("Cisco Solver: Configuration loaded", CONFIG);
  startMonitoring();
});

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === "updateConfig") {
    if (request.config.SHORTCUTS) {
      CONFIG.SHORTCUTS = { ...CONFIG.SHORTCUTS, ...request.config.SHORTCUTS };
    }
    CONFIG = { ...CONFIG, ...request.config };
    if (monitoringThread) clearInterval(monitoringThread);
    startMonitoring();
  }
});

function createStatusIndicator() {
  statusIndicator = document.createElement("div");
  statusIndicator.id = "cisco-status-indicator";
  Object.assign(statusIndicator.style, {
    position: "fixed",
    top: "0px",
    left: "0px",
    width: "2px",
    height: "2px",
    backgroundColor: "gray",
    zIndex: "2147483647", // Max z-index
    pointerEvents: "none",
  });
  document.body.appendChild(statusIndicator);
}

// Call it to initialize
createStatusIndicator();

function startMonitoring() {
  if (monitoringThread) clearInterval(monitoringThread);
  console.log("Cisco Solver: Monitoring started.");
  monitoringThread = setInterval(async () => {
    if (isProcessing) return;
    try {
      isProcessing = true;
      await scanAndSolve(false);
    } catch (error) {
      console.error("Cisco Solver: Critical Error in loop:", error);
    } finally {
      isProcessing = false;
    }
  }, Number.parseInt(CONFIG.CHECK_INTERVAL));
}

async function scanAndSolve(forceRefetch = false) {
  const appRoot = findAppRoot(document);
  if (!appRoot) {
    // Only log occasionally to avoid console spam
    if (Math.random() < 0.01 && CONFIG.DEBUG)
      console.log("Cisco Solver: No App Root found.");
    return;
  }

  const allComponents = findAllQuestionComponents(appRoot);

  const activeComponents = allComponents.filter((el) => {
    // 1. Check basic visibility (CSS display/opacity)
    const visible = isElementVisible(el);
    if (!visible) return false;

    // 2. Check viewport visibility (Must be on screen to process)
    if (!isInViewport(el)) return false;

    // 3. Check if already solved
    const alreadySolved = isAlreadySolved(el);
    if (alreadySolved && !forceRefetch) return false;

    return true;
  });

  if (activeComponents.length === 0) return;

  if (CONFIG.DEBUG) {
    console.log(
      `Cisco Solver: Processing ${activeComponents.length} active visible components.`,
    );
  }

  if (forceRefetch) {
    activeComponents.forEach((comp) => clearMarkersFromComponent(comp));
  }

  for (const component of activeComponents) {
    await processComponent(component);
  }
}

async function processComponent(component) {
  const data = extractDataFromComponent(component);

  if (!data) {
    if (CONFIG.DEBUG)
      console.warn(
        "Cisco Solver: Extraction failed for visible component.",
        component,
      );
    return;
  }

  if (statusIndicator) statusIndicator.style.backgroundColor = "gray";

  if (CONFIG.DEBUG) {
    console.log("Cisco Solver: Extracted Data:", {
      type: data.type || "standard",
      question: data.question.substring(0, 50) + "...",
      optionsCount: data.options.length,
      firstOption: data.options[0],
    });
  }

  // Construct payload based on component type
  const payload = {
    question: data.question,
    overrides: {
      candidateCount: Number.parseInt(CONFIG.CANDIDATE_COUNT),
      minQuestionSimilarity: Number.parseFloat(CONFIG.MIN_QUESTION_SIMILARITY),
      minAnswerSimilarity: Number.parseFloat(CONFIG.MIN_ANSWER_SIMILARITY),
    },
  };

  // If matching type (Drag & Drop), send terms and definitions
  if (data.type === "matching") {
    payload.terms = data.terms;
    payload.definitions = data.definitions;
  } else {
    // Standard Multiple Choice / Checklist
    payload.options = data.options;
  }

  try {
    const response = await fetch(`${CONFIG.SERVER_URL}/solve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      const result = await response.json();
      if (CONFIG.DEBUG) console.log("Cisco Solver: Server response", result);

      if (result.matchingPairs?.length > 0 && data.type === "matching") {
        if (statusIndicator) statusIndicator.style.backgroundColor = "#00ff00";
        highlightMatchingPairs(result.matchingPairs, data);
      } else if (result.answers?.length > 0) {
        if (statusIndicator) statusIndicator.style.backgroundColor = "#00ff00";
        // Highlight logic remains the same (mapping returned answers to UI elements)
        highlightAnswers(result.answers, data.optionElements, data.root);
      } else {
        if (CONFIG.DEBUG)
          console.log(
            "Cisco Solver: No confidence answers found. Marking as attempted.",
          );
        if (statusIndicator) statusIndicator.style.backgroundColor = "#ff0000";
        component.setAttribute("data-cisco-attempted", "true");
      }
    } else {
      if (CONFIG.DEBUG)
        console.error("Cisco Solver: Server returned status", response.status);
      if (statusIndicator) statusIndicator.style.backgroundColor = "#ff0000";
      component.setAttribute("data-cisco-attempted", "true");
    }
  } catch (e) {
    if (statusIndicator) statusIndicator.style.backgroundColor = "#ff0000";
    console.error("Cisco Solver: Fetch error:", e);
  }
}

function findAppRoot(root) {
  if (root.getElementById("questions")) return root.getElementById("questions");
  if (root.querySelector("app-root")) return root;
  if (root.querySelector("article-view")) return root;
  if (root.querySelector(".question")) return root.body || root;
  return null;
}

function findAllQuestionComponents(root, results = []) {
  if (!root) return results;

  // 1. Known Shadow DOM components (Standard & Matching)
  const candidates = root.querySelectorAll(
    "mcq-view, checklist-view, object-matching-view",
  );
  candidates.forEach((el) => results.push(el));

  // 2. Standard DOM components (Virtuoso/New structure)
  const standardQuestions = root.querySelectorAll(".question");
  standardQuestions.forEach((el) => results.push(el));

  // 3. Recursive Shadow DOM search
  const allElements = root.querySelectorAll("*");
  for (const el of allElements) {
    if (el.shadowRoot) findAllQuestionComponents(el.shadowRoot, results);
  }

  // 4. FAILSAFE: If no specific components found, look for generic containers with inputs
  if (results.length === 0) {
    // Look for containers that wrap multiple inputs but aren't the whole body
    const potentialContainers = root.querySelectorAll(
      "div, section, article, fieldset",
    );
    potentialContainers.forEach((container) => {
      // Check if this container directly has inputs or meaningful text
      const inputs = container.querySelectorAll(
        'input[type="radio"], input[type="checkbox"]',
      );
      if (inputs.length >= 2) {
        const hasText = container.innerText.length > 20;
        if (hasText && !container.hasAttribute("data-cisco-checked")) {
          results.push(container);
          container.setAttribute("data-cisco-checked", "true"); // Temp marker to avoid re-adding
        }
      }
    });
  }

  return results;
}

function extractDataFromComponent(component) {
  const result =
    extractStrategyModern(component) ||
    extractStrategyObjectMatching(component) || // Special handling for Drag & Drop
    extractStrategyShadow(component) ||
    extractStrategyHeuristic(component);

  return result;
}

// Strategy 0: Object Matching (Drag and Drop)
function extractStrategyObjectMatching(component) {
  if (component.tagName.toLowerCase() !== "object-matching-view") return null;
  const root = component.shadowRoot;
  if (!root) return null;

  // 1. Extract Question Text
  // The question text is often hidden inside a nested base-view shadow root
  let questionText = "";

  // Try finding it inside the nested base-view first
  const baseView = root.querySelector("base-view");
  if (baseView && baseView.shadowRoot) {
    const bodyEl = baseView.shadowRoot.querySelector(".component__body-inner");
    if (bodyEl) questionText = cleanText(bodyEl.innerText);
  }

  // Fallback: Try direct selector if structure is flattened
  if (!questionText) {
    const bodyEl = root.querySelector(".objectMatching__body-inner");
    if (bodyEl) questionText = cleanText(bodyEl.innerText);
  }

  if (!questionText) return null;

  // 2. Extract Terms (Left Side - Categories)
  const termElements = Array.from(
    root.querySelectorAll(".categories-container .category-item-text"),
  );
  const terms = termElements
    .map((el) => cleanText(el.innerText))
    .filter((t) => t.length > 0);

  // 3. Extract Definitions (Right Side - Options)
  const definitionWrappers = Array.from(
    root.querySelectorAll(".options-container .objectMatching-option-item"),
  );

  const definitions = [];
  const optionElements = [];

  definitionWrappers.forEach((wrapper) => {
    // Text is nested deeper in the structure
    const textEl = wrapper.querySelector(".category-item-text");
    if (textEl) {
      const text = cleanText(textEl.innerText);
      if (text) {
        definitions.push(text);
        optionElements.push(wrapper); // Highlight the button/wrapper
      }
    }
  });

  if (definitions.length < 2) return null;

  return {
    type: "matching",
    question: questionText,
    terms: terms,
    definitions: definitions,
    // "options" property kept for UI compatibility (highlightAnswers uses this mapped list elements)
    options: definitions,
    optionElements: optionElements,
    root: root,
  };
}

// Strategy 1: Modern DOM (.question structure)
function extractStrategyModern(component) {
  if (component.shadowRoot) return null;

  let questionText = "";

  // Try precise selectors first
  const qMatText = component.querySelector(".questionText .mattext");
  if (qMatText) questionText = cleanText(qMatText.innerText);

  if (!questionText) {
    const longDesc = component.querySelector(".item-long-description");
    if (longDesc) questionText = cleanText(longDesc.innerText);
  }

  // If we can't find specific question text class, this strategy fails, fallback to heuristic
  if (!questionText) return null;

  const labelElements = Array.from(
    component.querySelectorAll(".ai-option-label"),
  );
  if (labelElements.length === 0) return null;

  const optionElements = labelElements;
  const options = labelElements
    .map((el) => {
      const matText = el.querySelector(".mattext");
      return matText ? cleanText(matText.innerText) : cleanText(el.innerText);
    })
    .filter((t) => t.length > 0);

  if (options.length < 2) return null;

  return {
    question: questionText,
    options: options,
    optionElements: optionElements,
    root: null,
  };
}

// Strategy 2: Legacy Shadow DOM
function extractStrategyShadow(component) {
  if (!component.shadowRoot) return null;
  const shadow = component.shadowRoot;

  let questionText = "";
  const bodyEl = findInShadowRecursive(
    shadow,
    ".mcq__body-inner, .checklist__body-inner",
  );
  if (bodyEl) questionText = cleanText(bodyEl.innerText);

  if (!questionText) {
    const baseView = shadow.querySelector("base-view");
    if (baseView && baseView.shadowRoot) {
      const fallback = baseView.shadowRoot.querySelector('[class*="body"]');
      if (fallback) questionText = cleanText(fallback.innerText);
    }
  }

  if (!questionText) return null;

  let optionTextElements = Array.from(
    shadow.querySelectorAll(
      ".mcq__item-text-inner, .checklist__item-text-inner",
    ),
  );
  if (optionTextElements.length === 0) {
    optionTextElements = Array.from(
      shadow.querySelectorAll(
        'label[role="listitem"] .text-inner, label .text',
      ),
    );
  }

  const optionElements = optionTextElements.map(
    (el) =>
      el.closest("label") ||
      el.closest(".mcq__item-label") ||
      el.closest(".checklist__item-label") ||
      el,
  );

  const options = optionTextElements
    .map((el) => cleanText(el.innerText))
    .filter((t) => t.length > 0);

  if (options.length < 2) return null;

  return {
    question: questionText,
    options: options,
    optionElements: optionElements,
    root: shadow,
  };
}

// Strategy 3: Heuristic / Failsafe
// Looks for inputs and assumes text near inputs are options, and remaining text is question.
function extractStrategyHeuristic(component) {
  const root = component.shadowRoot || component;

  // 1. Find all possible option inputs
  const inputs = Array.from(
    root.querySelectorAll('input[type="radio"], input[type="checkbox"]'),
  );
  if (inputs.length < 2) return null;

  // 2. Identify Option Labels
  const optionElements = [];
  const options = [];
  let combinedOptionText = "";

  inputs.forEach((input) => {
    // Check for explicit label
    let label = null;
    if (input.id) {
      label = root.querySelector(`label[for="${input.id}"]`);
    }
    // Check for parent label
    if (!label) {
      label = input.closest("label");
    }
    // Check for sibling text
    if (!label) {
      // Find closest span or div with text next to it
      label = input.parentElement;
    }

    if (label) {
      const text = cleanText(label.innerText);
      if (text) {
        options.push(text);
        optionElements.push(label);
        combinedOptionText += text + " ";
      }
    }
  });

  if (options.length < 2) return null;

  // 3. Identify Question Text
  // Strategy: Get all text from component, remove the text we identified as options.
  // The largest remaining chunk at the top is likely the question.

  // Clone to not mess up DOM
  const clone = component.cloneNode(true);

  // Remove identifiable options from clone to isolate question text
  // (Naive approach: just replace the option strings)
  let rawText = cleanText(root.innerText || component.innerText);

  // Filter out the option texts from the raw text to leave behind the question
  options.forEach((opt) => {
    rawText = rawText.replace(opt, "");
  });

  // Cleanup noise
  const questionText = rawText
    .replace(/Select one:|Select one|Choose two|Choose matching term/gi, "")
    .replace(/Question \d+/i, "")
    .trim();

  // If we ended up with nothing, heuristic failed
  if (questionText.length < 5) return null;

  return {
    question: questionText,
    options: options,
    optionElements: optionElements,
    root: component.shadowRoot ? component.shadowRoot : null,
  };
}

function findInShadowRecursive(root, selector) {
  const found = root.querySelector(selector);
  if (found) return found;
  const children = root.querySelectorAll("*");
  for (const el of children) {
    if (el.shadowRoot) {
      const res = findInShadowRecursive(el.shadowRoot, selector);
      if (res) return res;
    }
  }
  return null;
}

function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .replace(
      /screenReader-position-text|Nem teljes|Kérdés \d+|Question \d+/gi,
      "",
    )
    .replace(/\s+\d+\s+(of|out of|\/|ből)\s+\d+\s*$/i, "") // Removes "1 of 50"
    .replace(/\(Points: \d+\)/i, "") // Remove points notation
    .trim();
}

function isInViewport(el) {
  const rect = el.getBoundingClientRect();
  return (
    rect.top < (window.innerHeight || document.documentElement.clientHeight) &&
    rect.bottom > 0 &&
    rect.left < (window.innerWidth || document.documentElement.clientWidth) &&
    rect.right > 0
  );
}

function isElementVisible(el) {
  try {
    const view = el.ownerDocument.defaultView;
    if (view) {
      const style = view.getComputedStyle(el);
      if (style.display === "none") return false;
      if (style.visibility === "hidden") return false;
      if (style.opacity === "0") return false;
    }
  } catch (e) {}

  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;

  return true;
}

function isAlreadySolved(component) {
  // Check if we found an answer previously (Visual marker)
  let hasMarker = false;
  if (component.shadowRoot) {
    hasMarker =
      !!component.shadowRoot.querySelector(".cisco-marker-target") ||
      !!component.shadowRoot.querySelector("[data-cisco-matched]");
  } else {
    hasMarker =
      !!component.querySelector(".cisco-marker-target") ||
      !!component.querySelector("[data-cisco-matched]");
  }

  // Check if we already tried this component but found nothing (Hidden attribute)
  const hasAttempted = component.hasAttribute("data-cisco-attempted");

  return hasMarker || hasAttempted;
}

function clearMarkersFromComponent(component) {
  const root = component.shadowRoot || component;

  // Clear visual markers (choice questions)
  root.querySelectorAll(".cisco-marker-target").forEach((el) => {
    el.classList.remove("cisco-marker-target");
    el.classList.remove("cisco-marker-with-input");
    el.removeAttribute("data-cisco-highlight");
  });

  // Clear matching dots (matching questions)
  root.querySelectorAll(".cisco-matching-dot").forEach((el) => {
    el.classList.remove("cisco-matching-dot");
    el.style.removeProperty("--cisco-dot-color");
    el.removeAttribute("data-cisco-matched");
  });

  // Clear matching hint letter spans (matching questions)
  root.querySelectorAll(".cisco-hint").forEach((el) => el.remove());

  // Clear matched attribute on remaining elements
  root.querySelectorAll("[data-cisco-matched]").forEach((el) => {
    el.removeAttribute("data-cisco-matched");
  });

  // Clear the "attempted" flag so we can retry
  component.removeAttribute("data-cisco-attempted");
}

function getMarkerCSS() {
  return `
		.cisco-marker-target { position: relative !important; }
		.cisco-marker-target::before {
			content: '' !important;
			position: absolute !important;
			/* Default position for text-only items */
			left: 1px !important; 
			top: 50% !important;
			transform: translateY(-50%) !important;
			width: ${CONFIG.MARKER_SIZE}px !important;
			height: ${CONFIG.MARKER_SIZE}px !important;
			background-color: ${CONFIG.MARKER_COLOR} !important;
			z-index: 9999 !important;
			pointer-events: none !important;
			opacity: var(--cisco-marker-opacity, 1) !important;
    }
      
    /* Specific positioning for Virtuoso items that contain real input elements */
    /* Adjusts marker to sit roughly in the middle of a standard checkbox/radio */
    .cisco-marker-with-input::before {
      top: calc(50% - 6.5px) !important;
			left: 0px !important; 
		}
	`;
}

function highlightAnswers(answerTexts, optionElements, shadowRoot) {
  // Case 1: Shadow DOM (Legacy)
  if (shadowRoot) {
    if (!shadowRoot.querySelector("#cisco-stealth-style")) {
      let style = shadowRoot.querySelector("#cisco-stealth-style");
      if (!style) {
        style = document.createElement("style");
        style.id = "cisco-stealth-style";
        shadowRoot.appendChild(style);
      }
      style.textContent = getMarkerCSS();
      shadowRoot.appendChild(style);
    }
  }
  // Case 2: Light DOM (New Structure)
  else {
    if (!document.getElementById("cisco-global-style")) {
      const style = document.createElement("style");
      style.id = "cisco-global-style";
      style.textContent = getMarkerCSS();
      document.head.appendChild(style);
    }
  }

  answerTexts.forEach((ans) => {
    // Normalization for comparison
    const cleanAns = cleanText(ans).toLowerCase();

    const target = optionElements.find((el) => {
      // Look deeper into the element if necessary
      const matText = el.querySelector(".mattext");
      const labelText = el.innerText || el.textContent;
      const txt = cleanText(
        matText ? matText.innerText : labelText,
      ).toLowerCase();

      // Fuzzy includes check
      return txt.includes(cleanAns) || cleanAns.includes(txt);
    });

    if (target) {
      target.classList.add("cisco-marker-target");

      // Detect input to improve marker positioning (Virtuoso support)
      const hasInput = target.querySelector(
        'input[type="radio"], input[type="checkbox"]',
      );
      if (hasInput) {
        target.classList.add("cisco-marker-with-input");
      }

      target.setAttribute("data-cisco-highlight", "true");
    }
  });
}

function highlightMatchingPairs(matchingPairs, data) {
  const root = data.root;

  // Create a map of category letters based on category order
  const categoryLetters = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const termLetterMap = new Map(); // cleaned term text → category letter
  data.terms.forEach((term, idx) => {
    const letter = categoryLetters[idx] || "";
    termLetterMap.set(cleanText(term).toLowerCase(), letter);
  });

  matchingPairs.forEach(({ term, definition }) => {
    const termKey = cleanText(term).toLowerCase();
    const letter = termLetterMap.get(termKey);

    const defClean = cleanText(definition).toLowerCase();
    const optionEl = data.optionElements.find((el) => {
      const txt = cleanText(
        el.querySelector(".category-item-text")?.innerText ?? el.innerText,
      ).toLowerCase();
      return txt.includes(defClean) || defClean.includes(txt);
    });

    if (!optionEl) {
      if (CONFIG.DEBUG)
        console.warn(
          `Cisco Solver: No element found for definition "${definition}"`,
        );
      return;
    }

    optionEl.setAttribute("data-cisco-matched", "true");

    // Add barely visible letter hint to the option text
    if (letter) {
      const textEl = optionEl.querySelector(".category-item-text");
      if (textEl && !textEl.querySelector(".cisco-hint")) {
        const hintSpan = document.createElement("span");
        hintSpan.className = "cisco-hint";
        hintSpan.textContent = letter.toLowerCase();
        hintSpan.style.cssText =
          "opacity: 0.1 !important; font-size: inherit !important; white-space: nowrap !important; display: inline !important;";
        // If there's an inner block element (div), append inside it so the
        // span stays inline with the text and never wraps to a new line.
        const innerBlock = textEl.querySelector("div");
        (innerBlock || textEl).appendChild(hintSpan);
      }
    }
  });
}

const keyboardState = {
  pressedKeys: new Set(),
  lastTrigger: {},
  DEBOUNCE_MS: 300,
};

function parseShortcut(shortcutString) {
  const parts = shortcutString.split("+").map((p) => p.trim());
  const parsed = {
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    key: null,
    code: null,
  };
  parts.forEach((part) => {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control") parsed.ctrl = true;
    else if (lower === "alt") parsed.alt = true;
    else if (lower === "shift") parsed.shift = true;
    else if (lower === "meta" || lower === "cmd" || lower === "command")
      parsed.meta = true;
    else {
      if (
        /^[A-Z][a-z]*[A-Z]/.test(part) ||
        /^(Numpad|Arrow|Page|Home|End|Insert|Delete)/.test(part)
      )
        parsed.code = part;
      else parsed.key = part.toLowerCase();
    }
  });
  return parsed;
}

function matchesShortcut(event, shortcutString) {
  const parsed = parseShortcut(shortcutString);
  if (parsed.ctrl !== event.ctrlKey) return false;
  if (parsed.alt !== event.altKey) return false;
  if (parsed.shift !== event.shiftKey) return false;
  if (parsed.meta !== event.metaKey) return false;
  if (parsed.code) return event.code === parsed.code;
  if (parsed.key) return event.key.toLowerCase() === parsed.key;
  return false;
}

function matchesAnyShortcut(event, shortcuts) {
  if (!shortcuts || !Array.isArray(shortcuts)) return false;
  return shortcuts.some((shortcut) => matchesShortcut(event, shortcut));
}

function shouldTriggerShortcut(actionName) {
  const now = Date.now();
  const lastTime = keyboardState.lastTrigger[actionName] || 0;
  if (now - lastTime < keyboardState.DEBOUNCE_MS) return false;
  keyboardState.lastTrigger[actionName] = now;
  return true;
}

document.addEventListener("keydown", (e) => {
  keyboardState.pressedKeys.add(e.code);

  if (matchesAnyShortcut(e, CONFIG.SHORTCUTS.toggleMarkers)) {
    if (!shouldTriggerShortcut("toggleMarkers")) return;
    e.preventDefault();
    e.stopPropagation();
    areMarkersVisible = !areMarkersVisible;
    document.documentElement.style.setProperty(
      "--cisco-marker-opacity",
      areMarkersVisible ? "1" : "0",
    );
    console.log("Cisco Solver: Markers toggled:", areMarkersVisible);
  }

  if (matchesAnyShortcut(e, CONFIG.SHORTCUTS.forceRefetch) && !isProcessing) {
    if (!shouldTriggerShortcut("forceRefetch")) return;
    e.preventDefault();
    e.stopPropagation();
    isProcessing = true;
    console.log("Cisco Solver: Force rescan triggered");
    scanAndSolve(true).finally(() => (isProcessing = false));
  }
});

document.addEventListener("keyup", (e) => {
  keyboardState.pressedKeys.delete(e.code);
});

window.updateShortcut = (actionName, shortcuts) => {
  if (!CONFIG.SHORTCUTS[actionName])
    return console.error(`Unknown action: ${actionName}`);
  CONFIG.SHORTCUTS[actionName] = shortcuts;
  chrome.storage.sync.set({ SHORTCUTS: CONFIG.SHORTCUTS }, () => {
    console.log(`Shortcut updated for ${actionName}:`, shortcuts);
  });
};

window.viewShortcuts = () =>
  console.log("Current shortcuts configuration:", CONFIG.SHORTCUTS);

window.testShortcut = (shortcutString) => {
  const parsed = parseShortcut(shortcutString);
  console.log("Parsed shortcut:", parsed);
  console.log("Press the key combination now to test...");
  const testHandler = (e) => {
    if (matchesShortcut(e, shortcutString)) {
      console.log("✓ Shortcut matched!", e.key, e.code);
      document.removeEventListener("keydown", testHandler);
    }
  };
  document.addEventListener("keydown", testHandler);
  setTimeout(() => {
    document.removeEventListener("keydown", testHandler);
    console.log("Test timeout");
  }, 5000);
};
