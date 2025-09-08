// ==UserScript==
// @name         Apple Music TTML Auto-Downloader
// @namespace    https://github.com/ban-heesoo/NewSync
// @version      1.0.0
// @description  Tangkap respons syllable-lyrics dari music.apple.com dan unduh TTML otomatis
// @author       You
// @match        https://music.apple.com/*
// @icon         https://www.apple.com/favicon.ico
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  const STATE = {
    autoDownload: true,
    lastTTML: null,
    lastMeta: null,
    beautify: true,
    customName: ''
  };

  function saveFile(content, fileName) {
    const blob = new Blob([content], { type: 'application/xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function getNowPlayingFromMusicKit() {
    try {
      const mk = window.MusicKit && window.MusicKit.getInstance && window.MusicKit.getInstance();
      const item = mk && mk.nowPlayingItem;
      if (!item) return null;
      const title = item.title || '';
      const artist = (item.artistName || (item.artist && item.artist.name)) || '';
      if (title || artist) return { title, artist };
    } catch (_) {}
    return null;
  }

  function getNowPlayingFromDOM() {
    try {
      // Heuristics: try common testids/text containers Apple uses
      const titleEl = document.querySelector('[data-testid="track-title"], [aria-label^="Playing"] [dir] span, [role="button"][data-testid*="track"] span');
      const artistEl = document.querySelector('[data-testid="track-subtitle"], [aria-label^="Playing"] a[href*="/artist/"]');
      const title = titleEl && titleEl.textContent && titleEl.textContent.trim();
      const artist = artistEl && artistEl.textContent && artistEl.textContent.trim();
      if (title || artist) return { title: title || '', artist: artist || '' };
    } catch (_) {}
    // fallback to document.title pattern
    try {
      const t = (document.title || '').replace(/\s+\|\s*Apple Music.*/i, '').trim();
      if (t) return { title: t, artist: '' };
    } catch (_) {}
    return null;
  }

  function deriveFileName(json) {
    try {
      // Prefer Now Playing info from MusicKit/DOM
      const np = getNowPlayingFromMusicKit() || getNowPlayingFromDOM();
      if (np && (np.title || np.artist)) {
        const coreNP = [np.title, np.artist].filter(Boolean).join(' - ');
        if (coreNP) return coreNP.replace(/[^A-Za-z0-9_\-\s]/g, '_') + '.ttml';
      }

      const data0 = json && json.data && json.data[0];
      const attrs = data0 && data0.attributes;
      const pp = attrs && attrs.playParams;
      const title = (attrs && (attrs.name || attrs.title)) || '';
      const artist = (attrs && (attrs.artistName || attrs.composerName)) || '';
      const id = (pp && (pp.id || pp.catalogId)) || (data0 && data0.id) || 'lyrics';
      const core = [title, artist].filter(Boolean).join(' - ') || id.toString();
      return core.replace(/[^A-Za-z0-9_\-\s]/g, '_') + '.ttml';
    } catch (e) {
      return 'lyrics.ttml';
    }
  }

  function prettyPrintXML(xmlString) {
    try {
      const blockTags = new Set(['tt','head','metadata','iTunesMetadata','body','div','p','songwriters','transliterations','translations']);
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlString, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) return xmlString;

      const pieces = [];
      function esc(text) {
        return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      }
      function serialize(node, depth) {
        const indent = '  '.repeat(depth);
        if (node.nodeType === 3) { // text
          const t = node.nodeValue || '';
          if (t.trim() === '') return; // skip pure whitespace
          pieces.push(esc(t));
          return;
        }
        if (node.nodeType !== 1) return; // elements only
        const tag = node.tagName;
        const attrs = Array.from(node.attributes).map(a => `${a.name}="${a.value}"`).join(' ');
        const openTag = attrs ? `<${tag} ${attrs}>` : `<${tag}>`;
        const closeTag = `</${tag}>`;
        const isBlock = blockTags.has(tag);

        const children = Array.from(node.childNodes);
        if (isBlock) pieces.push(`\n${indent}${openTag}`);
        else pieces.push(openTag);

        const hasElemChild = children.some(c => c.nodeType === 1);
        if (!hasElemChild) {
          // inline content
          children.forEach(c => serialize(c, depth));
        } else {
          children.forEach(c => serialize(c, isBlock ? depth + 1 : depth));
          if (isBlock) pieces.push(`\n${indent}`);
        }

        pieces.push(closeTag);
      }
      serialize(doc.documentElement, 0);
      let out = pieces.join('');
      out = out.replace(/^\n/, '');
      if (!out.endsWith('\n')) out += '\n';
      return out;
    } catch (_) {
      return xmlString;
    }
  }

  function extractTTML(json) {
    try {
      const direct = json && json.data && json.data[0] && json.data[0].attributes && json.data[0].attributes.ttmlLocalizations;
      if (direct && typeof direct === 'string') return direct;
    } catch (_) {}

    // fallback deep search
    function findFirstTTMLString(value) {
      if (!value) return null;
      if (typeof value === 'string') {
        const t = value.trim();
        if (t.startsWith('<tt ')) return value;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = findFirstTTMLString(item);
          if (found) return found;
        }
      } else if (typeof value === 'object') {
        for (const k of Object.keys(value)) {
          const found = findFirstTTMLString(value[k]);
          if (found) return found;
        }
      }
      return null;
    }
    return findFirstTTMLString(json);
  }

  function handleJSON(json) {
    const ttml = extractTTML(json);
    if (!ttml) return;
    STATE.lastTTML = STATE.beautify ? prettyPrintXML(ttml) : ttml;
    STATE.lastMeta = json;
    if (STATE.autoDownload) {
      const defaultName = deriveFileName(json);
      const name = (STATE.customName && STATE.customName.trim()) ? (STATE.customName.trim().endsWith('.ttml') ? STATE.customName.trim() : STATE.customName.trim() + '.ttml') : defaultName;
      saveFile(STATE.lastTTML, name);
      flash('TTML diunduh: ' + name);
    } else {
      flash('TTML ditangkap (klik Download di panel untuk simpan)');
    }
  }

  // UI
  function createPanel() {
    const panel = document.createElement('div');
    panel.style.position = 'fixed';
    panel.style.zIndex = '999999';
    panel.style.right = '12px';
    panel.style.bottom = '12px';
    panel.style.background = 'rgba(20,20,20,0.85)';
    panel.style.color = '#fff';
    panel.style.fontSize = '12px';
    panel.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    panel.style.border = '1px solid rgba(255,255,255,0.2)';
    panel.style.borderRadius = '8px';
    panel.style.padding = '8px 10px';
    panel.style.boxShadow = '0 2px 12px rgba(0,0,0,0.3)';

    const title = document.createElement('div');
    title.textContent = 'TTML Helper';
    title.style.fontWeight = '600';
    title.style.marginBottom = '6px';
    panel.appendChild(title);

    const autoWrap = document.createElement('label');
    autoWrap.style.display = 'flex';
    autoWrap.style.alignItems = 'center';
    autoWrap.style.gap = '6px';
    autoWrap.style.cursor = 'pointer';
    const auto = document.createElement('input');
    auto.type = 'checkbox';
    auto.checked = STATE.autoDownload;
    auto.addEventListener('change', () => {
      STATE.autoDownload = auto.checked;
    });
    const autoText = document.createElement('span');
    autoText.textContent = 'Auto download';
    autoWrap.appendChild(auto);
    autoWrap.appendChild(autoText);
    panel.appendChild(autoWrap);

    const beautWrap = document.createElement('label');
    beautWrap.style.display = 'flex';
    beautWrap.style.alignItems = 'center';
    beautWrap.style.gap = '6px';
    beautWrap.style.cursor = 'pointer';
    beautWrap.style.marginTop = '6px';
    const beaut = document.createElement('input');
    beaut.type = 'checkbox';
    beaut.checked = STATE.beautify;
    beaut.addEventListener('change', () => {
      STATE.beautify = beaut.checked;
    });
    const beautText = document.createElement('span');
    beautText.textContent = 'Beautify TTML';
    beautWrap.appendChild(beaut);
    beautWrap.appendChild(beautText);
    panel.appendChild(beautWrap);

    const nameLabel = document.createElement('div');
    nameLabel.textContent = 'Custom filename (.ttml):';
    nameLabel.style.marginTop = '8px';
    panel.appendChild(nameLabel);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'kosongkan untuk auto';
    nameInput.style.width = '220px';
    nameInput.style.padding = '4px 6px';
    nameInput.style.borderRadius = '6px';
    nameInput.style.border = '1px solid rgba(255,255,255,0.25)';
    nameInput.style.background = 'rgba(0,0,0,0.25)';
    nameInput.style.color = '#fff';
    nameInput.addEventListener('input', () => {
      STATE.customName = nameInput.value;
    });
    panel.appendChild(nameInput);

    const btnRow = document.createElement('div');
    btnRow.style.marginTop = '6px';
    btnRow.style.display = 'flex';
    btnRow.style.gap = '6px';

    const dl = document.createElement('button');
    dl.textContent = 'Download';
    dl.style.padding = '4px 8px';
    dl.style.border = '1px solid rgba(255,255,255,0.2)';
    dl.style.background = 'rgba(255,255,255,0.1)';
    dl.style.color = '#fff';
    dl.style.borderRadius = '6px';
    dl.style.cursor = 'pointer';
    dl.addEventListener('click', () => {
      if (!STATE.lastTTML) {
        flash('Belum ada TTML tertangkap');
        return;
      }
      const defaultName = deriveFileName(STATE.lastMeta || {});
      const name = (STATE.customName && STATE.customName.trim()) ? (STATE.customName.trim().endsWith('.ttml') ? STATE.customName.trim() : STATE.customName.trim() + '.ttml') : defaultName;
      const content = STATE.beautify ? prettyPrintXML(STATE.lastTTML) : STATE.lastTTML;
      saveFile(content, name);
      flash('TTML diunduh: ' + name);
    });
    btnRow.appendChild(dl);

    const copy = document.createElement('button');
    copy.textContent = 'Copy TTML';
    copy.style.padding = '4px 8px';
    copy.style.border = '1px solid rgba(255,255,255,0.2)';
    copy.style.background = 'rgba(255,255,255,0.1)';
    copy.style.color = '#fff';
    copy.style.borderRadius = '6px';
    copy.style.cursor = 'pointer';
    copy.addEventListener('click', async () => {
      if (!STATE.lastTTML) {
        flash('Belum ada TTML tertangkap');
        return;
      }
      try {
        await navigator.clipboard.writeText(STATE.lastTTML);
        flash('TTML disalin ke clipboard');
      } catch (e) {
        flash('Gagal menyalin TTML');
      }
    });
    btnRow.appendChild(copy);

    panel.appendChild(btnRow);
    document.documentElement.appendChild(panel);
  }

  function flash(msg) {
    const tip = document.createElement('div');
    tip.textContent = msg;
    tip.style.position = 'fixed';
    tip.style.right = '12px';
    tip.style.bottom = '60px';
    tip.style.background = 'rgba(0,0,0,0.8)';
    tip.style.color = '#fff';
    tip.style.padding = '6px 10px';
    tip.style.borderRadius = '6px';
    tip.style.zIndex = '1000000';
    tip.style.fontSize = '12px';
    document.body.appendChild(tip);
    setTimeout(() => tip.remove(), 1800);
  }

  function patchFetch() {
    const origFetch = window.fetch;
    window.fetch = async function(input, init) {
      let url = '';
      try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (_) {}
      const res = await origFetch.apply(this, arguments);
      try {
        const isLyrics = /syllable-lyrics|lyrics/i.test(url);
        if (isLyrics) {
          const clone = res.clone();
          const ctype = clone.headers.get('content-type') || '';
          if (ctype.includes('application/json')) {
            clone.json().then(handleJSON).catch(() => {});
          } else if (ctype.includes('text/plain') || ctype.includes('application/octet-stream')) {
            clone.text().then(t => {
              try { handleJSON(JSON.parse(t)); } catch (_) {}
            }).catch(() => {});
          }
        }
      } catch (_) {}
      return res;
    };
  }

  function patchXHR() {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__targetUrl = url || '';
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function() {
      this.addEventListener('load', function() {
        try {
          const url = this.__targetUrl || '';
          const isLyrics = /syllable-lyrics|lyrics/i.test(url);
          if (!isLyrics) return;
          const ctype = this.getResponseHeader('content-type') || '';
          if (ctype.includes('application/json')) {
            handleJSON(JSON.parse(this.responseText));
          } else if (ctype.includes('text/plain') || ctype.includes('application/octet-stream')) {
            try { handleJSON(JSON.parse(this.responseText)); } catch (_) {}
          }
        } catch (_) {}
      });
      return origSend.apply(this, arguments);
    };
  }

  function init() {
    try { createPanel(); } catch (_) {}
    try { patchFetch(); } catch (_) {}
    try { patchXHR(); } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();


