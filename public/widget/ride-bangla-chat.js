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

  var conversationId = null;
  var isOpen = false;

  function createStyles() {
    var style = document.createElement("style");
    style.textContent = "\n\
      #rbai-widget-container{position:fixed;bottom:20px;" + config.position + ":20px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}\n\
      #rbai-widget-btn{width:56px;height:56px;border-radius:50%;background:" + config.color + ";border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.15);transition:transform .2s}\n\
      #rbai-widget-btn:hover{transform:scale(1.05)}\n\
      #rbai-widget-btn svg{width:24px;height:24px;fill:#fff}\n\
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
          <h3>' + config.title + '</h3>\
          <button id="rbai-widget-close">&times;</button>\
        </div>\
        <div id="rbai-widget-messages"></div>\
        <div id="rbai-widget-input">\
          <input type="text" placeholder="Type a message..." id="rbai-widget-text" />\
          <button id="rbai-widget-send">Send</button>\
        </div>\
      </div>\
      <button id="rbai-widget-btn">\
        <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>\
      </button>\
    ';
    document.body.appendChild(container);

    document.getElementById("rbai-widget-btn").onclick = toggleWidget;
    document.getElementById("rbai-widget-close").onclick = toggleWidget;
    document.getElementById("rbai-widget-send").onclick = sendMessage;
    document.getElementById("rbai-widget-text").onkeypress = function (e) {
      if (e.key === "Enter") sendMessage();
    };
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
        conversationId = data.conversationId;
        addMessage(data.response || "Sorry, I could not process your request.", "bot");
      })
      .catch(function () {
        typing.remove();
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
