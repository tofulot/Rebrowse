(() => {
  const selector = 'input[type="password"],input[type="hidden"],[autocomplete^="cc-"],[autocomplete*="password"],[autocomplete="one-time-code"],[data-private],[data-sensitive]';
  let active = document.activeElement;
  for (let depth = 0; active && depth < 12; depth++) {
    if (active.closest(selector) || active.matches('iframe,object,embed')) return false;
    if (active.shadowRoot?.activeElement) { active = active.shadowRoot.activeElement; continue; }
    if (active.localName.includes('-') && !active.shadowRoot) return false;
    break;
  }
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount) {
    const range = selection.getRangeAt(0);
    if (Array.from(document.querySelectorAll(selector)).some((node) => range.intersectsNode(node))) return false;
  }
  return true;
})
