document.addEventListener("DOMContentLoaded", () => {
  const settingsBtn = document.getElementById("adguard-settings-btn");
  if (settingsBtn) {
    settingsBtn.addEventListener("click", () => {
      window.location.href = "popup.html";
    });
  }
});
