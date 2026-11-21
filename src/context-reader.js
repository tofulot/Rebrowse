(() => {
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const safeText = (el) => {
      if (el.closest('input,textarea,select,[contenteditable],[data-private],[data-sensitive]')) return "";
      const copy = el.cloneNode(true);
      copy.querySelectorAll('input,textarea,select,[contenteditable],[data-private],[data-sensitive],script,style,noscript,[hidden],[aria-hidden="true"]').forEach((node) => node.remove());
      return (copy.textContent || "").replace(/\s+/g, " ").trim();
    };
    return {
      url: location.href,
      title: document.title.slice(0, 160),
      headings: Array.from(document.querySelectorAll("h1,h2,h3")).filter(visible).slice(0, 15).map((el) => safeText(el).slice(0, 120)),
      actions: Array.from(document.querySelectorAll('a,button,[role="button"],[role="link"]')).filter((el) => visible(el) && !el.closest('[contenteditable],[data-private],[data-sensitive]')).slice(0, 50).map((el) => (el.getAttribute("aria-label") || safeText(el)).slice(0, 100)).filter(Boolean),
      excerpt: Array.from(document.querySelectorAll("main p,article p,p")).filter(visible).slice(0, 15).map(safeText).join("\n").slice(0, 3500),
      links: Array.from(document.querySelectorAll('a[href]')).filter((el) => visible(el) && !el.closest('nav,header,footer,[contenteditable],[data-private],[data-sensitive]'))
        .map((el) => ({ title: (el.getAttribute('aria-label') || safeText(el)).slice(0, 180), url: el.href })).filter((link) => link.title && /^https?:/.test(link.url)).slice(0, 60),
      lists: Array.from(document.querySelectorAll('ul,ol,table,[role="grid"],[role="list"]'))
        .filter((el) => visible(el) && !el.closest('nav,header,footer,aside,[contenteditable],[data-private],[data-sensitive]'))
        .map((el) => {
          const rows = Array.from(el.querySelectorAll(el.matches('table,[role="grid"]') ? 'tr,[role="row"]' : ':scope > li,:scope > [role="listitem"]'))
            .filter((row) => visible(row) && (!row.matches('tr,[role="row"]') || row.querySelector('td,[role="cell"],[role="gridcell"]'))).map((row) => safeText(row).slice(0, 220)).filter(Boolean);
          return { label: (el.getAttribute('aria-label') || el.querySelector('caption')?.textContent || 'Visible list').slice(0, 100), items: rows.slice(0, 40), truncated: rows.length > 40 || !!document.querySelector('[aria-label*="next page" i],[aria-label*="pagination" i]') };
        }).filter((list) => list.items.length >= 2).slice(0, 4),
    };})
