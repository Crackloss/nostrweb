/**
 * NostrFácil - Amber Follow (NIP-55)
 * Soporte de follow para Android vía Amber signer.
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
    const CALLBACK_BASE = window.location.origin + window.location.pathname;
    const STORAGE_KEY_PUBKEY = 'nostrfacil_amber_pubkey';
    const STORAGE_KEY_PENDING = 'nostrfacil_amber_pending';
    const STORAGE_KEY_CONTACTS = 'nostrfacil_amber_contacts';
    const STORAGE_KEY_CONTACT_EVENT = 'nostrfacil_amber_contact_event';

    // ─── State ───────────────────────────────────────────────
    let userPubkeyHex = null;
    let userContacts = new Set();
    let userContactEvent = null;
    let amberReady = false;

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

    // ─── Detection ───────────────────────────────────────────
    function isAndroid() {
        return /android/i.test(navigator.userAgent);
    }

    function hasNip07() {
        return typeof window.nostr !== 'undefined' && window.nostr !== null;
    }

    // ─── Relay communication ─────────────────────────────────
    function queryRelay(relayUrl, filter) {
        return new Promise((resolve) => {
            let ws;
            const subId = 'ab_' + Math.random().toString(36).slice(2, 8);
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
        console.log('[nostr-amber] Publish results:', results);
        return results;
    }

    // ─── Contact list ────────────────────────────────────────
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
            try {
                sessionStorage.setItem(STORAGE_KEY_CONTACTS, JSON.stringify([...userContacts]));
                sessionStorage.setItem(STORAGE_KEY_CONTACT_EVENT, JSON.stringify(event));
            } catch {}
        }
    }

    function loadCachedContacts() {
        try {
            const cached = sessionStorage.getItem(STORAGE_KEY_CONTACTS);
            const cachedEvent = sessionStorage.getItem(STORAGE_KEY_CONTACT_EVENT);
            if (cached) userContacts = new Set(JSON.parse(cached));
            if (cachedEvent) userContactEvent = JSON.parse(cachedEvent);
            return cached !== null;
        } catch { return false; }
    }

    // ─── Amber intent URLs ───────────────────────────────────
    function amberGetPublicKey() {
        const callbackUrl = CALLBACK_BASE + '?amber_pubkey=';
        window.location.href = `nostrsigner:?compressionType=none&returnType=signature&type=get_public_key&callbackUrl=${encodeURIComponent(callbackUrl)}`;
    }

    function amberSignEvent(eventJson, targetHex) {
        try { sessionStorage.setItem(STORAGE_KEY_PENDING, targetHex); } catch {}

        const encoded = encodeURIComponent(eventJson);
        const callbackUrl = CALLBACK_BASE + '?amber_event=';
        window.location.href = `nostrsigner:${encoded}?compressionType=none&returnType=event&type=sign_event&callbackUrl=${encodeURIComponent(callbackUrl)}`;
    }

    // ─── Follow action ───────────────────────────────────────
    function buildFollowEvent(targetHex) {
        let tags = [];
        if (userContactEvent && userContactEvent.tags) {
            tags = [...userContactEvent.tags];
        }
        if (tags.some(t => t[0] === 'p' && t[1] === targetHex)) return null;
        tags.push(['p', targetHex]);

        return JSON.stringify({
            kind: 3,
            created_at: Math.floor(Date.now() / 1000),
            tags: tags,
            content: userContactEvent ? userContactEvent.content : '',
        });
    }

    function followWithAmber(targetHex, button) {
        const eventJson = buildFollowEvent(targetHex);
        if (!eventJson) {
            button.textContent = '✓ Siguiendo';
            button.classList.add('following');
            button.disabled = true;
            return;
        }
        button.textContent = '⏳';
        button.disabled = true;
        setTimeout(() => amberSignEvent(eventJson, targetHex), 100);
    }

    // ─── Handle Amber callbacks ──────────────────────────────
    async function handleAmberReturn() {
        const fullUrl = window.location.href;
        const qIndex = fullUrl.indexOf('?');
        if (qIndex === -1) return null;

        const queryString = fullUrl.slice(qIndex + 1);

        // ── Callback: get_public_key ──
        if (queryString.startsWith('amber_pubkey=')) {
            const pubkey = queryString.slice('amber_pubkey='.length).replace(/[^a-f0-9]/gi, '');
            if (pubkey && pubkey.length >= 64) {
                userPubkeyHex = pubkey.slice(0, 64);
                try { sessionStorage.setItem(STORAGE_KEY_PUBKEY, userPubkeyHex); } catch {}
            }
            window.history.replaceState({}, '', CALLBACK_BASE);
            return 'pubkey';
        }

        // ── Callback: sign_event ──
        if (queryString.startsWith('amber_event=')) {
            const raw = queryString.slice('amber_event='.length);
            window.history.replaceState({}, '', CALLBACK_BASE);

            let signedEvent;
            try {
                const decoded = decodeURIComponent(raw);
                signedEvent = JSON.parse(decoded);
            } catch {
                try {
                    signedEvent = JSON.parse(raw);
                } catch {
                    try {
                        if (raw.startsWith('Signer1')) {
                            const b64 = raw.slice(7);
                            const binary = atob(b64);
                            const bytes = new Uint8Array(binary.length);
                            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                            const ds = new DecompressionStream('gzip');
                            const text = await new Response(
                                new Blob([bytes]).stream().pipeThrough(ds)
                            ).text();
                            signedEvent = JSON.parse(text);
                        }
                    } catch (err) {
                        console.error('[nostr-amber] Parse error:', err);
                        return 'error';
                    }
                }
            }

            if (!signedEvent || !signedEvent.sig) {
                console.error('[nostr-amber] Invalid signed event:', signedEvent);
                return 'error';
            }

            console.log('[nostr-amber] Publishing signed event:', signedEvent);
            const results = await publishToRelays(signedEvent);
            const success = results.some(r => r.ok === true);

            const pendingHex = sessionStorage.getItem(STORAGE_KEY_PENDING);
            if (success && pendingHex) {
                userContacts.add(pendingHex);
                userContactEvent = signedEvent;
                try {
                    sessionStorage.setItem(STORAGE_KEY_CONTACTS, JSON.stringify([...userContacts]));
                    sessionStorage.setItem(STORAGE_KEY_CONTACT_EVENT, JSON.stringify(signedEvent));
                    sessionStorage.removeItem(STORAGE_KEY_PENDING);
                } catch {}
            } else {
                try { sessionStorage.removeItem(STORAGE_KEY_PENDING); } catch {}
            }

            return success ? 'follow_ok' : 'follow_error';
        }

        return null;
    }

    // ─── UI ──────────────────────────────────────────────────
    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .amber-connect-bar {
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
            .amber-connect-btn {
                padding: 0.5rem 1.2rem;
                border: 1px solid #f7931a;
                background: #f7931a;
                color: #fff;
                border-radius: 8px;
                font-family: inherit;
                font-size: 0.82rem;
                font-weight: 600;
                cursor: pointer;
            }
            .amber-connect-btn:hover { background: #e8850f; }
            .amber-login-bar {
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
            .amber-login-bar .status-dot {
                width: 8px; height: 8px; border-radius: 50%;
                background: #f7931a; flex-shrink: 0;
            }
            .amber-login-bar .user-npub {
                font-family: monospace; font-size: 0.75rem; color: var(--text-secondary);
            }
            .amber-disconnect-btn {
                padding: 0.3rem 0.6rem; border: 1px solid var(--border);
                background: transparent; color: var(--text-secondary);
                border-radius: 6px; font-size: 0.7rem; cursor: pointer;
            }
            .follow-btn-amber {
                padding: 0.45rem 0.85rem;
                border: 1px solid #f7931a;
                background: #f7931a;
                color: #fff;
                border-radius: 8px;
                font-family: inherit;
                font-size: 0.78rem;
                font-weight: 600;
                cursor: pointer;
                white-space: nowrap;
            }
            .follow-btn-amber:hover:not(:disabled) { background: #e8850f; }
            .follow-btn-amber:disabled { cursor: default; }
            .follow-btn-amber.following {
                background: transparent; color: var(--success); border-color: var(--success);
            }
            .copy-npub-btn-amber {
                padding: 0.35rem 0.6rem;
                border: 1px solid var(--border);
                background: transparent;
                color: var(--text-secondary);
                border-radius: 6px;
                font-size: 0.7rem;
                cursor: pointer;
            }
            .copy-npub-btn-amber:hover {
                color: #f7931a; border-color: #f7931a;
            }
            .copy-npub-btn-amber.copied {
                color: var(--success); border-color: var(--success);
            }
            .amber-toast {
                position: fixed; bottom: 2rem; left: 50%; transform: translateX(-50%);
                padding: 0.75rem 1.5rem; background: var(--bg-tertiary);
                border: 1px solid var(--success); border-radius: 10px;
                color: var(--success); font-size: 0.85rem; font-weight: 600;
                z-index: 1000; animation: amberFadeIn 0.3s ease;
            }
            .amber-toast.error { border-color: #f87171; color: #f87171; }
            @keyframes amberFadeIn {
                from { opacity: 0; transform: translateX(-50%) translateY(10px); }
                to { opacity: 1; transform: translateX(-50%) translateY(0); }
            }
        `;
        document.head.appendChild(style);
    }

    function showToast(message, isError) {
        const toast = document.createElement('div');
        toast.className = 'amber-toast' + (isError ? ' error' : '');
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    function showConnectBar() {
        const container = document.querySelector('.search-box');
        if (!container) return;
        const bar = document.createElement('div');
        bar.className = 'amber-connect-bar';
        bar.id = 'amber-bar';
        bar.innerHTML = `
            <span>🤖 ¿Tienes Amber?</span>
            <button class="amber-connect-btn" id="amber-connect-btn">🔑 Conectar con Amber</button>
        `;
        container.parentNode.insertBefore(bar, container);
        document.getElementById('amber-connect-btn').addEventListener('click', (e) => {
            e.preventDefault();
            amberGetPublicKey();
        });
    }

    function showLoginBar(pubkeyHex) {
        const existing = document.getElementById('amber-bar');
        if (existing) existing.remove();
        const container = document.querySelector('.search-box');
        if (!container) return;
        const npubShort = pubkeyHex.slice(0, 8) + '...' + pubkeyHex.slice(-6);
        const bar = document.createElement('div');
        bar.className = 'amber-login-bar';
        bar.id = 'amber-bar';
        bar.innerHTML = `
            <span class="status-dot"></span>
            <span>Conectado vía Amber</span>
            <span class="user-npub">${npubShort}</span>
            <button class="amber-disconnect-btn" id="amber-disconnect">✕</button>
        `;
        container.parentNode.insertBefore(bar, container);
        document.getElementById('amber-disconnect').addEventListener('click', () => {
            try {
                sessionStorage.removeItem(STORAGE_KEY_PUBKEY);
                sessionStorage.removeItem(STORAGE_KEY_CONTACTS);
                sessionStorage.removeItem(STORAGE_KEY_CONTACT_EVENT);
                sessionStorage.removeItem(STORAGE_KEY_PENDING);
            } catch {}
            location.reload();
        });
    }

    function addFollowButtons() {
        const cards = document.querySelectorAll('.profile-card');

        cards.forEach(card => {
            if (card.querySelector('.follow-btn-amber') || card.querySelector('.copy-npub-btn-amber')) return;

            const npub = card.dataset.npub;
            if (!npub) return;

            const hex = npubToHex(npub);
            const linkParent = card.querySelector('.profile-link');
            if (!linkParent) return;
            linkParent.classList.add('profile-actions');

            // Copy button (always)
            const copyBtn = document.createElement('button');
            copyBtn.className = 'copy-npub-btn-amber';
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
            linkParent.appendChild(copyBtn);

            // Follow button (only if logged in and not self)
            if (!hex || !userPubkeyHex || hex === userPubkeyHex) return;

            const isFollowing = userContacts.has(hex);
            const btn = document.createElement('button');
            btn.className = 'follow-btn-amber' + (isFollowing ? ' following' : '');
            btn.textContent = isFollowing ? '✓ Siguiendo' : 'Follow';
            btn.disabled = isFollowing;
            btn.dataset.hex = hex;
            btn.addEventListener('click', () => followWithAmber(hex, btn));
            linkParent.insertBefore(btn, linkParent.firstChild);
        });
    }

    // ─── Init ────────────────────────────────────────────────
    async function init() {
        await new Promise(r => setTimeout(r, 700));
        if (hasNip07()) return;
        if (!isAndroid()) return;

        injectStyles();

        const callbackResult = await handleAmberReturn();

        if (!userPubkeyHex) {
            try { userPubkeyHex = sessionStorage.getItem(STORAGE_KEY_PUBKEY); } catch {}
        }

        if (callbackResult === 'follow_ok') showToast('✓ Follow realizado con éxito');
        else if (callbackResult === 'follow_error') showToast('✗ Error al publicar el follow', true);
        else if (callbackResult === 'error') showToast('✗ Error al procesar firma de Amber', true);

        if (userPubkeyHex) {
            amberReady = true;
            showLoginBar(userPubkeyHex);
            loadCachedContacts();
            waitForDirectory(() => {
                addFollowButtons();
                loadUserContacts().then(() => {
                    document.querySelectorAll('.follow-btn-amber').forEach(b => b.remove());
                    document.querySelectorAll('.copy-npub-btn-amber').forEach(b => b.remove());
                    addFollowButtons();
                });
            });
        } else {
            showConnectBar();
            // Still add copy buttons
            waitForDirectory(addFollowButtons);
        }

        const observer = new MutationObserver(() => {
            setTimeout(addFollowButtons, 100);
        });
        const directory = document.getElementById('directory');
        if (directory) observer.observe(directory, { childList: true });
    }

    function waitForDirectory(callback) {
        const dir = document.getElementById('directory');
        if (!dir) { callback(); return; }
        if (dir.querySelector('.profile-card')) { callback(); return; }
        const obs = new MutationObserver((mutations, observer) => {
            if (dir.querySelector('.profile-card')) { observer.disconnect(); callback(); }
        });
        obs.observe(dir, { childList: true });
        setTimeout(() => { obs.disconnect(); callback(); }, 5000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
