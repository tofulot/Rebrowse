(function(options) {
  if (window !== window.top || location.origin === options.dashboardOrigin) return;
  if (!/^https?:$/.test(location.protocol)) return;
  const win = window;
  if (win.__rebrowseInstalled) return;
  win.__rebrowseInstalled = true;
  const emit = (kind, label) => {
    if (document.visibilityState !== "visible") return;
    const url = new URL(location.href);
    url.search = ""; url.hash = ""; url.username = ""; url.password = "";
    console.debug(options.marker + JSON.stringify({ kind, label: label.slice(0, 100), url: url.href, time: Date.now() }));
  };
  const target = (event) => event.target instanceof Element ? event.target : null;
  const field = (element) => element.matches("input,textarea,select") || !!element.closest('[contenteditable]:not([contenteditable="false"])');
  const sensitive = (element) => element.matches('input[type="password"],input[type="hidden"],[autocomplete^="cc-"],[autocomplete*="password"],[autocomplete="one-time-code"]');
  const label = (element) => {
    if (field(element)) return element.matches('input[type="search"]') ? "Search field" : "Form field";
    return (element.getAttribute("aria-label") || element.textContent || element.tagName).replace(/\s+/g, " ").trim().slice(0, 100);
  };
  let hoverTimer;
  let editTimer;
  let scrollTimer;
  let previousScroll = scrollY;
  document.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    clearTimeout(hoverTimer);
    const element = target(event)?.closest('a,button,input,select,textarea,[role="button"],[role="link"]');
    if (element && !sensitive(element)) emit("click", label(element));
  }, true);
  document.addEventListener("pointerover", (event) => {
    if (!event.isTrusted) return;
    clearTimeout(hoverTimer);
    const element = target(event)?.closest('a,button,[role="button"],[role="link"]');
    if (element) hoverTimer = setTimeout(() => emit("hover", label(element)), 650);
  }, true);
  document.addEventListener("pointerout", () => clearTimeout(hoverTimer), true);
  document.addEventListener("input", (event) => {
    const element = target(event);
    if (!event.isTrusted || !element || sensitive(element)) return;
    clearTimeout(editTimer);
    editTimer = setTimeout(() => emit("edit", label(element)), 700);
  }, true);
  document.addEventListener("focusin", (event) => {
    const element = target(event);
    if (event.isTrusted && element && field(element) && !sensitive(element)) emit("focus", label(element));
  }, true);
  document.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const max = document.documentElement.scrollHeight - innerHeight;
      const direction = scrollY >= previousScroll ? "down" : "up";
      previousScroll = scrollY;
      emit("scroll", `Scrolled ${direction} · ${max > 0 ? Math.round(scrollY / max * 100) : 0}% of page`);
    }, 450);
  }, true);
  window.addEventListener("focus", () => emit("tab", "Returned to this tab"));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) emit("tab", "Switched to this tab");
  });
})
