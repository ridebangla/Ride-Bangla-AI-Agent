/**
 * Ride Bangla AI Agent - Live Chat Widget
 * Embeddable chat widget for customer websites.
 *
 * Usage:
 * <script src="https://your-rbai-instance.com/widget/ride-bangla-chat.js"
 *   data-server="https://your-rbai-instance.com"
 *   data-site-key="YOUR_SITE_KEY"
 *   data-visitor-id="UNIQUE_VISITOR_ID"
 *   data-color="#0B7A55"
 *   data-position="right"
 *   data-greeting="Hi! How can we help you today?"
 * ></script>
 *
 * The backend resolves the business (tenant) from the `siteKey`.
 * `visitorId` lets the agent keep one conversation per visitor.
 */
(function () {
  "use strict";

  var script = document.currentScript;
  var config = {
    server: script.getAttribute("data-server") || window.location.origin,
    siteKey: script.getAttribute("data-site-key") || "",
    visitorId: script.getAttribute("data-visitor-id") || "",
    color: script.getAttribute("data-color") || "#0B7A55",
    position: script.getAttribute("data-position") || "right",
    greeting: script.getAttribute("data-greeting") || "Hi! How can we help you today?",
    title: script.getAttribute("data-title") || "Ride Bangla AI Agent",
  };

  var avatarUrl = config.server.replace(/\/$/, "") + "/agent-avatar.png";
  var idleVideoUrl = config.server.replace(/\/$/, "") + "/agent-idle.mp4";
  var workingVideoUrl = config.server.replace(/\/$/, "") + "/agent-working.mp4";
  var agentState = "idle";
  var pendingRequests = 0;

  var conversationId = null;
  var isOpen = false;

  function createStyles() {
    var style = document.createElement("style");
    style.textContent = "\n\
      #rbai-widget-container{position:fixed;bottom:20px;" + config.position + ":20px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}\n\
      #rbai-widget-btn{width:56px;height:56px;border-radius:50%;background:" + config.color + ";border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.15);transition:transform .2s}\n\
      #rbai-widget-btn:hover{transform:scale(1.05)}\n\
      #rbai-widget-btn{overflow:hidden;padding:0}\n\.rbai-avatarwrap{position:relative;display:block;overflow:hidden;background:#fff}\n\#rbai-widget-btn .rbai-avatarwrap{width:56px;height:56px;border-radius:50%}\n\#rbai-widget-header .rbai-avatarwrap{width:36px;height:36px;border-radius:50%;margin-right:10px;flex:none}\n\.rbai-vid{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none;pointer-events:none}\n\.rbai-vid.active{display:block}\n\.rbai-avatar-fallback{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none}\n\.rbai-avatarwrap.novid .rbai-avatar-fallback{display:block}\n\.rbai-avatarwrap.novid .rbai-vid{display:none!important}\n\#rbai-widget-headwrap{display:flex;align-items:center}\n\
      #rbai-widget-panel{display:none;width:370px;height:520px;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.12);margin-bottom:12px;overflow:hidden;flex-direction:column}\n\
      #rbai-widget-panel.open{display:flex}\n\
      #rbai-widget-header{background:" + config.color + ";color:#fff;padding:16px;display:flex;align-items:center;justify-content:space-between}\n\
      #rbai-widget-header h3{margin:0;font-size:15px;font-weight:600}\n\
      #rbai-widget-close{background:none;border:none;color:#fff;cursor:pointer;font-size:20px;padding:0;line-height:1}\n\
      #rbai-widget-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}\n\
      .rbai-msg{max-width:80%;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.4;word-wrap:break-word}\n\
      .rbai-msg.bot{background:#F1F5F9;color:#1E293B;align-self:flex-start;border-bottom-left-radius:4px}\n\
      .rbai-msg.user{background:" + config.color + ";color:#fff;align-self:flex-end;border-bottom-right-radius:4px}\n\
      .rbai-msg.typing{color:#94A3B8;font-style:italic}\n\
      #rbai-widget-input{display:flex;border-top:1px solid #E2E8F0;padding:12px}\n\
      #rbai-widget-input input{flex:1;border:1px solid #E2E8F0;border-radius:8px;padding:10px 14px;font-size:14px;outline:none}\n\
      #rbai-widget-input input:focus{border-color:" + config.color + "}\n\
      #rbai-widget-input button{background:" + config.color + ";color:#fff;border:none;border-radius:8px;padding:10px 16px;margin-left:8px;cursor:pointer;font-size:14px}\n\
    ";
    document.head.appendChild(style);
  }

  function createWidget() {
    var container = document.createElement("div");
    container.id = "rbai-widget-container";
    container.innerHTML = '\
      <div id="rbai-widget-panel">\
        <div id="rbai-widget-header">\
          <div id="rbai-widget-headwrap"><span class="rbai-avatarwrap"><video class="rbai-vid rbai-vid-idle active" muted loop playsinline autoplay preload="auto" disablepictureinpicture src="' + idleVideoUrl + '"></video><video class="rbai-vid rbai-vid-working" muted loop playsinline preload="auto" disablepictureinpicture src="' + workingVideoUrl + '"></video><img class="rbai-avatar-fallback" src="' + avatarUrl + '" alt=""/></span><h3>' + config.title + '</h3></div>\
          <button id="rbai-widget-close">&times;</button>\
        </div>\
        <div id="rbai-widget-messages"></div>\
        <div id="rbai-widget-input">\
          <input type="text" placeholder="Type a message..." id="rbai-widget-text" />\
          <button id="rbai-widget-send">Send</button>\
        </div>\
      </div>\
      <button id="rbai-widget-btn" aria-label="Open chat">\
        <span class="rbai-avatarwrap"><video class="rbai-vid rbai-vid-idle active" muted loop playsinline autoplay preload="auto" disablepictureinpicture src="' + idleVideoUrl + '"></video><video class="rbai-vid rbai-vid-working" muted loop playsinline preload="auto" disablepictureinpicture src="' + workingVideoUrl + '"></video><img class="rbai-avatar-fallback" src="' + avatarUrl + '" alt=""/></span>\
      </button>\
    ';
    document.body.appendChild(container);
    wireVideoFallback();
    // Ensure the visible idle video actually plays (autoplay policies).
    var iv = container.querySelector(".rbai-vid-idle");
    if (iv) iv.play().catch(function () {});

    document.getElementById("rbai-widget-btn").onclick = toggleWidget;
    document.getElementById("rbai-widget-close").onclick = toggleWidget;
    document.getElementById("rbai-widget-send").onclick = sendMessage;
    document.getElementById("rbai-widget-text").onkeypress = function (e) {
      if (e.key === "Enter") sendMessage();
    };
  }

  function setAgentState(s) {
    var showWorking = s === "working";
    if (agentState === s && !showWorking) return;
    agentState = s;
    var idles = document.querySelectorAll(".rbai-vid-idle");
    var workings = document.querySelectorAll(".rbai-vid-working");
    for (var i = 0; i < idles.length; i++) {
      idles[i].classList.toggle("active", !showWorking);
      if (showWorking) { idles[i].pause(); }
      else { idles[i].play().catch(function () {}); }
    }
    for (var j = 0; j < workings.length; j++) {
      workings[j].classList.toggle("active", showWorking);
      if (showWorking) { try { workings[j].currentTime = 0; } catch (e) {} workings[j].play().catch(function () {}); }
      else { workings[j].pause(); }
    }
  }

  function wireVideoFallback() {
    var vids = document.querySelectorAll(".rbai-vid");
    for (var i = 0; i < vids.length; i++) {
      vids[i].addEventListener("error", function () {
        var wrap = this.closest(".rbai-avatarwrap");
        if (wrap) wrap.classList.add("novid");
      });
      // If autoplay was blocked, retry on first user interaction.
      vids[i].addEventListener("play", function () {}, false);
    }
    document.addEventListener("click", function once() {
      var act = document.querySelector(".rbai-vid.active");
      if (act && act.paused) act.play().catch(function () {});
    }, { once: true });
  }

  function toggleWidget() {
    isOpen = !isOpen;
    var panel = document.getElementById("rbai-widget-panel");
    panel.classList.toggle("open", isOpen);
    if (isOpen && !document.querySelector(".rbai-msg")) {
      addMessage(config.greeting, "bot");
    }
  }

  function addMessage(text, type) {
    var messages = document.getElementById("rbai-widget-messages");
    var msg = document.createElement("div");
    msg.className = "rbai-msg " + type;
    msg.textContent = text;
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
    return msg;
  }

  function sendMessage() {
    var input = document.getElementById("rbai-widget-text");
    var text = input.value.trim();
    if (!text) return;

    addMessage(text, "user");
    input.value = "";
    pendingRequests++;
    setAgentState("working");

    var typing = addMessage("Typing...", "bot typing");

    fetch(config.server + "/api/chat/widget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        conversationId: conversationId,
        siteKey: config.siteKey,
        visitorId: config.visitorId,
      }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        typing.remove();
        pendingRequests = Math.max(0, pendingRequests - 1);
        if (pendingRequests === 0) setAgentState("idle");
        conversationId = data.conversationId;
        addMessage(data.response || "Sorry, I could not process your request.", "bot");
      })
      .catch(function () {
        typing.remove();
        pendingRequests = Math.max(0, pendingRequests - 1);
        if (pendingRequests === 0) setAgentState("idle");
        addMessage("Connection error. Please try again.", "bot");
      });
  }

  // Initialize
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      createStyles();
      createWidget();
    });
  } else {
    createStyles();
    createWidget();
  }
})();
