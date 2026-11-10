(function(options) {
  if (window !== window.top || location.origin === options.dashboardOrigin) return;
  if (!/^https?:$/.test(location.protocol)) return;
  const win = window;
  if (win.__rebrowseInstalled) return;
  win.__rebrowseInstalled = true;
  const emit = (kind, label, clipboard) => {
    if (document.visibilityState !== "visible" || win.__rebrowseSuppressed) return;
    const url = new URL(location.href);
    url.search = ""; url.hash = ""; url.username = ""; url.password = "";
    console.debug(options.marker + JSON.stringify({ kind, label: label.slice(0, 100), url: url.href, time: Date.now(), ...(clipboard ? { clipboard } : {}) }));
  };
  const target = (event) => event.target instanceof Element ? event.target : null;
  const field = (element) => element.matches("input,textarea,select") || !!element.closest('[contenteditable]:not([contenteditable="false"])');
  const sensitive = (element) => !!element.closest('input[type="password"],input[type="hidden"],[autocomplete^="cc-"],[autocomplete*="password"],[autocomplete="one-time-code"],[data-private],[data-sensitive]');
  const protectedFocus = () => {
    let element = document.activeElement;
    for (let depth = 0; element instanceof Element && depth < 12; depth++) {
      if (sensitive(element) || element.matches('iframe,object,embed')) return true;
      if (element.shadowRoot?.activeElement) { element = element.shadowRoot.activeElement; continue; }
      if (element.localName?.includes('-') && !element.shadowRoot) return true;
      break;
    }
    return false;
  };
  const label = (element) => {
    if (field(element)) return element.matches('input[type="search"]') ? "Search field" : "Form field";
    return (element.getAttribute("aria-label") || element.textContent || element.tagName).replace(/\s+/g, " ").trim().slice(0, 100);
  };
  let hoverTimer;
  let editTimer;
  let scrollTimer;
  let previousScroll = scrollY;
  for (const kind of ['copy', 'cut', 'paste']) document.addEventListener(kind, (event) => {
    if (!options.clipboardEnabled || win.__rebrowseSuppressed || !event.isTrusted || document.visibilityState !== 'visible') return;
    const element = target(event) || document.activeElement;
    if (!(element instanceof Element)) return;
    // Never read the event's data or selected value in a protected field.
    if (sensitive(element) || protectedFocus() || (event.composedPath?.() || []).some((node) => node instanceof Element && sensitive(node))) {
      emit(kind, `${kind === 'paste' ? 'Paste' : kind === 'cut' ? 'Cut' : 'Copy'} in a protected field · text excluded`,
        { format: 'unavailable', truncated: false, source: 'page', target: 'field', redacted: true }); return;
    }
    let text;
    const transfer = event.clipboardData;
    if (transfer && Array.from(transfer.types).includes('text/plain')) text = transfer.getData('text/plain');
    if (kind !== 'paste' && text === undefined) {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        if (element.selectionStart !== null && element.selectionEnd !== null) text = element.value.slice(element.selectionStart, element.selectionEnd);
      } else {
        const selection = window.getSelection();
        const selected = selection?.anchorNode?.parentElement;
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (selected && sensitive(selected) || range && Array.from(document.querySelectorAll('[data-private],[data-sensitive]')).some((node) => range.intersectsNode(node))) {
          emit(kind, 'Clipboard selection protected · text excluded', { format: 'unavailable', truncated: false, source: 'page', target: 'field', redacted: true }); return;
        }
        if (selection && !selection.isCollapsed) text = selection.toString();
      }
    }
    const clipboard = { ...(text === undefined ? {} : { text: text.slice(0, 2048) }), format: text !== undefined ? 'text' : transfer?.types?.length ? 'non-text' : 'unavailable',
      truncated: (text?.length || 0) > 2048, source: 'page', target: element.matches('input[type="search"]') ? 'search' : field(element) ? 'field' : 'page' };
    emit(kind, `${kind === 'paste' ? 'Pasted' : kind === 'cut' ? 'Cut' : 'Copied'} ${clipboard.format === 'text' ? 'text' : 'clipboard content'} ${kind === 'paste' ? 'into' : 'from'} ${clipboard.target === 'search' ? 'a search field' : clipboard.target === 'field' ? 'a form field' : 'the page'}`, clipboard);
  }, true);
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
