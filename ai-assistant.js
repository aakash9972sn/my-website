/* Shared assistant UI. Public page context only; conversations stay in memory. */
(() => {
  "use strict";
  const config = window.AAKASH_AI;
  if (!config?.endpoint) return;
  const assetBase = new URL(".", document.currentScript.src);
  const spark = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 1v22M1 12h22M4 4l16 16M4 20 20 4"/></svg>';
  const arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14"/></svg>';
  const host = document.createElement("aakash-assistant");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<link rel="stylesheet" href="${new URL("ai-assistant.css?v=20261121-ai1", assetBase)}"><button class="launcher" aria-haspopup="dialog" aria-label="Open AI assistant"><span aria-hidden="true">${spark}</span> Ask Gemini</button><dialog aria-labelledby="assistant-title"><header><div class="mark" aria-hidden="true">${spark}</div><div><span class="eyebrow">BLUNDER · GEMINI SHOPPING ASSISTANT</span><h2 id="assistant-title"></h2></div><button class="close" aria-label="Close AI assistant">×</button></header><div class="conversation"><div class="welcome"><span class="spark" aria-hidden="true">${spark}</span><h3>What’s on your mind?</h3><p></p><div class="suggestions"></div></div><div class="messages" role="log" aria-label="Conversation" aria-live="polite"></div></div><div class="status" role="status"></div><form><label class="sr-only" for="ai-question">Your question</label><textarea id="ai-question" rows="2" maxlength="700" placeholder="Ask in English or Hindi…" required></textarea><button class="send" aria-label="Send question">${arrow}</button></form><footer><span>AI can make mistakes. Check the source details.</span><button type="button" class="clear">Clear chat</button></footer><p class="privacy"></p></dialog>`;
  document.body.appendChild(host);
  const $ = (s) => root.querySelector(s),
    dialog = $("dialog"),
    input = $("textarea"),
    status = $(".status"),
    messages = $(".messages");
  $("#assistant-title").textContent = config.title || "Aakash Assistant";
  $(".welcome p").textContent = config.intro || "Ask about this page.";
  $(".privacy").textContent =
    config.privacy ||
    "Your question and public page context are sent to Google Gemini when you ask. Do not include private details.";
  let history = [],
    busy = false,
    controller,
    sequence = 0,
    lastQuestion = "";
  for (const question of config.suggestions || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = question;
    button.addEventListener("click", () => {
      input.value = question;
      submit();
    });
    $(".suggestions").appendChild(button);
  }
  function permitted() {
    return !config.isAllowed || config.isAllowed();
  }
  function open(question) {
    if (!permitted()) return;
    if (!dialog.open) dialog.showModal();
    if (question) input.value = question;
    if (!window.HostedAI?.configured?.()) {
      status.textContent = "Gemini is not connected on this GitHub Pages site. " +
        "Deploy the Node backend and configure BLUNDER_AI_API_ORIGIN.";
    }
    input.focus();
  }
  function cancel() {
    sequence++;
    controller?.abort();
    controller = null;
    busy = false;
    $(".send").disabled = false;
    $(".send").innerHTML = arrow;
    status.textContent = "";
  }
  $(".launcher").addEventListener("click", () => open());
  $(".close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    cancel();
    $(".launcher").focus({ preventScroll: true });
  });
  $(".clear").addEventListener("click", () => {
    cancel();
    history = [];
    lastQuestion = "";
    messages.replaceChildren();
    $(".welcome").hidden = false;
    input.value = "";
    input.focus();
  });
  function bubble(text, role) {
    const div = document.createElement("div");
    div.className = "message " + role;
    const label = document.createElement("b");
    label.textContent = role === "user" ? "You" : config.title || "Assistant";
    const content = document.createElement("p");
    content.textContent = text;
    div.append(label, content);
    messages.appendChild(div);
    $(".conversation").scrollTop = $(".conversation").scrollHeight;
    return div;
  }
  async function submit() {
    const question = input.value.trim();
    if (busy || question.length < 2 || !permitted()) return;
    if (question.length > 700) {
      status.textContent = "Keep your question under 700 characters.";
      return;
    }
    const context = config.context?.();
    if (!context) {
      status.textContent = "The page is still loading. Try again in a moment.";
      return;
    }
    busy = true;
    const id = ++sequence;
    controller = new AbortController();
    $(".send").disabled = true;
    $(".send").textContent = "…";
    status.textContent = "Connecting to Gemini…";
    $(".welcome").hidden = true;
    if (question !== lastQuestion) bubble(question, "user");
    lastQuestion = question;
    input.value = "";
    let assistantMessage = null;
    try {
      const data = await window.HostedAI.request({
        action: "assistant",
        app: config.app,
        question,
        context,
        history: history.slice(-6).map(message=>({
          role: message.role,
          content: message.content.slice(0,800)
        }))
      }, AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(45000)
      ]), (partial) => {
        if (id !== sequence) return;
        if (!assistantMessage) assistantMessage = bubble("", "assistant");
        assistantMessage.querySelector("p").textContent = partial;
        status.textContent = "";
      });
      if (typeof data?.answer !== "string" || !data.answer.trim())
        throw new Error("Gemini returned no answer. Please retry.");
      if (id !== sequence) return;
      const answer = data.answer.slice(0,8000);
      if (!assistantMessage) assistantMessage = bubble(answer, "assistant");
      else assistantMessage.querySelector("p").textContent = answer;
      history.push(
        { role: "user", content: question },
        { role: "assistant", content: answer },
      );
      history = history.slice(-6);
      lastQuestion = "";
      status.textContent = "";
    } catch (error) {
      if (id !== sequence) return;
      if (assistantMessage) {
        assistantMessage.querySelector("p").textContent += "\n[Answer interrupted. Please retry.]";
      }
      status.textContent =
        error.name === "TimeoutError"
          ? "The answer took too long. Please try again."
          : error.message || "AI is unavailable. Try again.";
      input.value = question;
    } finally {
      if (id === sequence) {
        busy = false;
        $(".send").disabled = false;
        $(".send").innerHTML = arrow;
        input.focus();
      }
    }
  }
  $("form").addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  function availability() {
    host.hidden = !permitted();
    if (host.hidden && dialog.open) dialog.close();
  }
  window.addEventListener("hashchange", availability);
  availability();
  window.AakashAssistant = Object.freeze({ open });
})();
