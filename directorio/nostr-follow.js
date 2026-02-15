/**
 * NostrFácil - Follow Button (NIP-07)
 * Detecta extensiones Nostr (nos2x, Alby, etc.), consulta la contact list
 * del usuario y permite hacer follow a perfiles del directorio.
 *
 * Requiere: window.nostr (NIP-07)
 * No modifica nada si no hay extensión instalada.
 */

(function () {
    'use strict';

    // ─── Config ──────────────────────────────────────────────
    const RELAYS = [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.primal.net',
        'wss://purplepag.es',
        'wss://relay.nostr.band',
    ];
    const WRITE_RELAYS = [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.primal.net',
        'wss://purplepag.es',
    ];
    const RELAY_TIMEOUT = 6000;
    const NIP07_DETECT_DELAY = 600;

    // ─── State ───────────────────────────────────────────────
    let userPubkeyHex = null;
    let userContacts = new Set();
    let userContactEvent = null;
    let nostrReady = false;

    // ─── Bech32 → Hex ────────────────────────────────────────
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

    function bech32Decode(str) {
        str = str.toLowerCase();
        const pos = str.lastIndexOf('1');
        if (pos < 1) return null;
        const dataChars = str.slice(pos + 1);
        const data = [];
        for (let i = 0; i < dataChars.length; i++) {
            const idx = CHARSET.indexOf(dataChars[i]);
            if (idx === -1) return null;
            data.push(idx);
        }
        const values = data.slice(0, -6);
        return { hrp: str.slice(0, pos), data: convertBits(values, 5, 8, false) };
    }

    function convertBits(data, fromBits, toBits, pad) {
        let acc = 0, bits = 0;
        const result = [];
        const maxv = (1 << toBits) - 1;
        for (let i = 0; i < data.length; i++) {
            acc = (acc << fromBits) | data[i];
            bits += fromBits;
            while (bits >= toBits) {
                bits -= toBits;
                result.push((acc >> bits) & maxv);
            }
        }
        if (pad && bits > 0) result.push((acc << (toBits - bits)) & maxv);
        return result;
    }

    function npubToHex(npub) {
        try {
            const decoded = bech32Decode(npub);
            if (!decoded || decoded.hrp !== 'npub') return null;
            return decoded.data.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch { return null; }
    }

    // ─── Relay communication ─────────────────────────────────
    function queryRelay(relayUrl, filter) {
        return new Promise((resolve) => {
            let ws;
            const subId = 'nf_' + Math.random().toString(36).slice(2, 8);
            const events = [];
            let settled = false;

            const timeout = setTimeout(() => {
                if (!settled) { settled = true; try { ws.close(); } catch {} resolve(events); }
            }, RELAY_TIMEOUT);

            try { ws = new WebSocket(relayUrl); } catch {
                clearTimeout(timeout); resolve(events); return;
            }

            ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]));
            ws.onmessage = (msg) => {
                try {
                    const data = JSON.parse(msg.data);
                    if (data[0] === 'EVENT' && data[1] === subId) events.push(data[2]);
                    else if (data[0] === 'EOSE' && data[1] === subId) {
                        if (!settled) { settled = true; clearTimeout(timeout); ws.close(); resolve(events); }
                    }
                } catch {}
            };
            ws.onerror = () => {
                if (!settled) { settled = true; clearTimeout(timeout); resolve(events); }
            };
        });
    }

    function publishToRelay(relayUrl, event) {
        return new Promise((resolve) => {
            let ws, settled = false;
            const timeout = setTimeout(() => {
                if (!settled) { settled = true; try { ws.close(); } catch {} resolve({ url: relayUrl, ok: false, msg: 'timeout' }); }
            }, RELAY_TIMEOUT);
            try { ws = new WebSocket(relayUrl); } catch { clearTimeout(timeout); resolve({ url: relayUrl, ok: false, msg: 'connect error' }); return; }
            ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
            ws.onmessage = (msg) => {
                try {
                    const data = JSON.parse(msg.data);
                    if (data[0] === 'OK' && !settled) {
                        settled = true; clearTimeout(timeout); ws.close();
                        resolve({ url: relayUrl, ok: data[2] === true, msg: data[3] || '' });
                    }
                } catch {}
            };
            ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timeout); resolve({ url: relayUrl, ok: false, msg: 'ws error' }); } };
        });
    }

    async function publishToRelays(event) {
        const results = await Promise.all(WRITE_RELAYS.map(url => publishToRelay(url, event)));
        console.log('[nostr-follow] Publish results:', results);
        return results;
    }

    // ─── Contact list (kind 3) ───────────────────────────────
    async function fetchContactList(pubkeyHex) {
        const filter = { kinds: [3], authors: [pubkeyHex], limit: 1 };
        const results = await Promise.all(RELAYS.map(url => queryRelay(url, filter)));
        let newest = null;
        for (const events of results) {
            for (const ev of events) {
                if (!newest || ev.created_at > newest.created_at) newest = ev;
            }
        }
        return newest;
    }

    async function loadUserContacts() {
        if (!userPubkeyHex) return;
        const event = await fetchContactList(userPubkeyHex);
        if (event) {
            userContactEvent = event;
            userContacts = new Set(
                event.tags.filter(t => t[0] === 'p').map(t => t[1])
            );
        }
    }

    // ─── Follow action ──────────────────────────────────────
    async function followUser(targetHex, button) {
        if (!window.nostr || !userPubkeyHex) return;

        button.disabled = true;
        button.textContent = '⏳';

        try {
            let tags = [];
            if (userContactEvent && userContactEvent.tags) {
                tags = [...userContactEvent.tags];
            }

            const alreadyFollows = tags.some(t => t[0] === 'p' && t[1] === targetHex);
            if (alreadyFollows) {
                button.textContent = '✓ Siguiendo';
                button.classList.add('following');
                return;
            }

            tags.push(['p', targetHex]);

            const event = {
                kind: 3,
                created_at: Math.floor(Date.now() / 1000),
                tags: tags,
                content: userContactEvent ? userContactEvent.content : '',
            };

            // Sign with extension
            const signed = await window.nostr.signEvent(event);
            console.log('[nostr-follow] Signed event:', signed);

            if (!signed || !signed.sig) {
                throw new Error('Firma inválida');
            }

            // Publish
            const results = await publishToRelays(signed);
            const success = results.some(r => r.ok === true);

            if (success) {
                userContacts.add(targetHex);
                userContactEvent = signed;
                button.textContent = '✓ Siguiendo';
                button.classList.add('following');
                button.disabled = true;
                console.log('[nostr-follow] Follow exitoso');
            } else {
                console.error('[nostr-follow] Ningún relay aceptó:', results);
                button.textContent = '✗ Error';
                button.disabled = false;
                setTimeout(() => {
                    button.textContent = 'Follow';
                    button.classList.remove('following');
                }, 2000);
            }
        } catch (err) {
            console.error('[nostr-follow] Follow error:', err);
            button.textContent = 'Follow';
            button.disabled = false;
        }
    }

    // ─── UI ──────────────────────────────────────────────────
    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .follow-btn {
                padding: 0.45rem 0.85rem;
                border: 1px solid var(--accent);
                background: var(--accent);
                color: #fff;
                border-radius: 8px;
                font-family: inherit;
                font-size: 0.78rem;
                font-weight: 600;
                cursor: pointer;
                transition: background 0.2s, opacity 0.2s;
                white-space: nowrap;
            }

            .follow-btn:hover:not(:disabled) {
                background: var(--accent-hover);
            }

            .follow-btn:disabled {
                cursor: default;
            }

            .follow-btn.following {
                background: transparent;
                color: var(--success);
                border-color: var(--success);
            }

            .follow-btn.loading {
                opacity: 0.6;
            }

            .nostr-login-bar {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 0.75rem;
                padding: 0.75rem 1rem;
                margin-bottom: 1.5rem;
                background: var(--bg-secondary);
                border: 1px solid var(--border);
                border-radius: 10px;
                font-size: 0.85rem;
                color: var(--text-secondary);
            }

            .nostr-login-bar .status-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: var(--success);
                flex-shrink: 0;
            }

            .nostr-login-bar .user-npub {
                font-family: monospace;
                font-size: 0.75rem;
                color: var(--text-secondary);
            }

            .copy-npub-btn {
                padding: 0.35rem 0.6rem;
                border: 1px solid var(--border);
                background: transparent;
                color: var(--text-secondary);
                border-radius: 6px;
                font-size: 0.7rem;
                cursor: pointer;
                transition: color 0.2s, border-color 0.2s;
            }

            .copy-npub-btn:hover {
                color: var(--accent);
                border-color: var(--accent);
            }

            .copy-npub-btn.copied {
                color: var(--success);
                border-color: var(--success);
            }
        `;
        document.head.appendChild(style);
    }

    function showLoginBar(pubkeyHex) {
        const container = document.querySelector('.search-box');
        if (!container) return;

        const npubShort = 'npub...' + pubkeyHex.slice(-8);
        const bar = document.createElement('div');
        bar.className = 'nostr-login-bar';
        bar.innerHTML = `
            <span class="status-dot"></span>
            <span>Conectado vía extensión Nostr</span>
            <span class="user-npub">${npubShort}</span>
        `;
        container.parentNode.insertBefore(bar, container);
    }

    function addFollowButtons() {
        const cards = document.querySelectorAll('.profile-card');

        cards.forEach(card => {
            if (card.querySelector('.follow-btn') || card.querySelector('.copy-npub-btn')) return;

            const link = card.querySelector('.profile-link a');
            if (!link) return;

            const npub = card.dataset.npub;
            if (!npub) return;

            const hex = npubToHex(npub);

            // Copy button (always)
            const copyBtn = document.createElement('button');
            copyBtn.className = 'copy-npub-btn';
            copyBtn.textContent = '📋';
            copyBtn.title = 'Copiar npub';
            copyBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(npub).then(() => {
                    copyBtn.textContent = '✓';
                    copyBtn.classList.add('copied');
                    setTimeout(() => {
                        copyBtn.textContent = '📋';
                        copyBtn.classList.remove('copied');
                    }, 1500);
                });
            });

            const linkParent = card.querySelector('.profile-link');
            if (!linkParent) return;
            linkParent.classList.add('profile-actions');
            linkParent.appendChild(copyBtn);

            // Follow button (only if logged in and not self)
            if (!hex || !userPubkeyHex || hex === userPubkeyHex) return;

            const isFollowing = userContacts.has(hex);

            const btn = document.createElement('button');
            btn.className = 'follow-btn' + (isFollowing ? ' following' : '');
            btn.textContent = isFollowing ? '✓ Siguiendo' : 'Follow';
            btn.disabled = isFollowing;
            btn.dataset.hex = hex;

            btn.addEventListener('click', () => followUser(hex, btn));

            linkParent.insertBefore(btn, linkParent.firstChild);
        });
    }

    // ─── Init ────────────────────────────────────────────────
    async function init() {
        await new Promise(r => setTimeout(r, NIP07_DETECT_DELAY));

        if (!window.nostr) return;

        injectStyles();

        // Always add copy buttons even before login
        // (will be added after directory loads)

        try {
            userPubkeyHex = await window.nostr.getPublicKey();
        } catch {
            // User denied — still show copy buttons
            waitForDirectory(addFollowButtons);
            observeDirectory();
            return;
        }

        if (!userPubkeyHex) {
            waitForDirectory(addFollowButtons);
            observeDirectory();
            return;
        }

        nostrReady = true;
        showLoginBar(userPubkeyHex);

        await loadUserContacts();
        waitForDirectory(addFollowButtons);
        observeDirectory();
    }

    function waitForDirectory(callback) {
        const dir = document.getElementById('directory');
        if (!dir) { callback(); return; }
        if (dir.querySelector('.profile-card')) { callback(); return; }

        const obs = new MutationObserver((mutations, observer) => {
            if (dir.querySelector('.profile-card')) {
                observer.disconnect();
                callback();
            }
        });
        obs.observe(dir, { childList: true });
        setTimeout(() => { obs.disconnect(); callback(); }, 5000);
    }

    function observeDirectory() {
        const observer = new MutationObserver(() => {
            setTimeout(addFollowButtons, 50);
        });
        const directory = document.getElementById('directory');
        if (directory) {
            observer.observe(directory, { childList: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window._nostrFollow = { npubToHex, userContacts: () => userContacts };
})();
