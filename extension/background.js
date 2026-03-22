console.log("Background worker started");

chrome.action.onClicked.addListener((tab) => {
  console.log("Extension icon clicked for tab:", tab.id);

  chrome.tabs.sendMessage(tab.id, { action: "extract" }, (response) => {
    if (response) {
      console.log("Extracted data:", response);
    }
  });
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension installed/updated");
});
