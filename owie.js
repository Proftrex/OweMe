/* =====================================================
   OWIE AI ASSISTANT — STEP 1 UI
   UI shell only. AI/data integration comes later.
   ===================================================== */

(function initOwie() {
  "use strict";

  function avatarMarkup(sizeClass) {
    return `
      <div class="owie-${sizeClass}-avatar">
        <img src="assets/owelogo.png" alt="Owie">
        <div class="owie-${sizeClass}-face" aria-hidden="true">
          <span class="owie-face-eye left"></span>
          <span class="owie-face-eye right"></span>
          <span class="owie-face-cheek left"></span>
          <span class="owie-face-cheek right"></span>
          <span class="owie-face-mouth"></span>
        </div>
      </div>
    `;
  }

  function assistantMarkup() {
    return `
      <div id="owieAssistant" class="hidden">

        <section id="owiePanel" class="hidden" aria-label="Owie AI Assistant">

          <header class="owie-panel-header">
            ${avatarMarkup("panel")}

            <div class="owie-panel-heading">
              <strong>Owie</strong>
              <span>Your OweMe assistant</span>
            </div>

            <button
              id="owieClose"
              type="button"
              aria-label="Close Owie"
            >
              ×
            </button>
          </header>

          <div class="owie-panel-body">
            <div class="owie-greeting">
              <div class="owie-message">
                <strong>Hi! I'm Owie 👋</strong><br>
                I'm here to help you make sense of your expenses.
              </div>
            </div>

            <div class="owie-quick-title">Try asking me</div>

            <div class="owie-quick-actions">
              <button type="button" class="owie-quick-action">Who owes me?</button>
              <button type="button" class="owie-quick-action">How much do I owe?</button>
              <button type="button" class="owie-quick-action">Show my recent expenses</button>
              <button type="button" class="owie-quick-action">Help me settle up</button>
            </div>
          </div>

          <form class="owie-input-row" id="owieForm">
            <input
              id="owieInput"
              type="text"
              autocomplete="off"
              placeholder="Ask Owie..."
              aria-label="Message Owie"
            >
            <button id="owieSend" type="submit" aria-label="Send message">➜</button>
          </form>

        </section>

        <button
          id="owieLauncher"
          type="button"
          aria-label="Open Owie AI Assistant"
          aria-expanded="false"
        >
          ${avatarMarkup("mini")}
        </button>

      </div>
    `;
  }

  function install() {
    if (document.getElementById("owieAssistant")) {
      return;
    }

    document.body.insertAdjacentHTML("beforeend", assistantMarkup());

    const assistant = document.getElementById("owieAssistant");
    const panel = document.getElementById("owiePanel");
    const launcher = document.getElementById("owieLauncher");
    const close = document.getElementById("owieClose");
    const form = document.getElementById("owieForm");
    const input = document.getElementById("owieInput");

    function isAppVisible() {
      const mainApp = document.getElementById("mainApp");
      return !!mainApp && !mainApp.classList.contains("hidden");
    }

    function syncVisibility() {
      assistant.classList.toggle("hidden", !isAppVisible());

      if (!isAppVisible()) {
        panel.classList.add("hidden");
        launcher.setAttribute("aria-expanded", "false");
      }
    }

    function openOwie() {
      panel.classList.remove("hidden");
      launcher.setAttribute("aria-expanded", "true");
      window.setTimeout(() => input.focus(), 50);
    }

    function closeOwie() {
      panel.classList.add("hidden");
      launcher.setAttribute("aria-expanded", "false");
    }

    launcher.addEventListener("click", () => {
      if (panel.classList.contains("hidden")) {
        openOwie();
      } else {
        closeOwie();
      }
    });

    close.addEventListener("click", closeOwie);

    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !panel.classList.contains("hidden")) {
        closeOwie();
      }
    });

    document.addEventListener("click", event => {
      const quickAction = event.target.closest(".owie-quick-action");
      if (!quickAction) {
        return;
      }

      input.value = quickAction.textContent.trim();
      input.focus();
    });

    form.addEventListener("submit", event => {
      event.preventDefault();

      const message = input.value.trim();
      if (!message) {
        return;
      }

      /* Step 1: UI only. The real Owie brain will be connected later. */
      input.value = "";

      const body = panel.querySelector(".owie-panel-body");
      const messageBubble = document.createElement("div");
      messageBubble.className = "owie-message";
      messageBubble.style.marginTop = "12px";
      messageBubble.style.marginLeft = "auto";
      messageBubble.style.background = "#fff";
      messageBubble.style.borderRadius = "16px 16px 5px 16px";
      messageBubble.textContent = message;
      body.appendChild(messageBubble);
      body.scrollTop = body.scrollHeight;

      window.setTimeout(() => {
        const reply = document.createElement("div");
        reply.className = "owie-message";
        reply.style.marginTop = "10px";
        reply.innerHTML = "I'm still learning! 💚 We'll connect my OweMe brain next.";
        body.appendChild(reply);
        body.scrollTop = body.scrollHeight;
      }, 350);
    });

    syncVisibility();

    const mainApp = document.getElementById("mainApp");
    if (mainApp) {
      const observer = new MutationObserver(syncVisibility);
      observer.observe(mainApp, {
        attributes: true,
        attributeFilter: ["class"]
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install);
  } else {
    install();
  }
})();
