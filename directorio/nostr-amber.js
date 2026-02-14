/**
 * NostrFácil - Amber Follow (NIP-55)
 * Soporte de follow para Android vía Amber signer.
 * Funciona con web estática usando callbackUrl con query params.
 *
 * Flujo:
 * 1. Detectar Android + no window.nostr → mostrar botón "Conectar Amber"
 * 2. Redirigir a nostrsigner: para get_public_key con callbackUrl
 * 3. Amber devuelve pubkey como query param al recargar la página
 * 4. Guardar pubkey en sessionStorage, cargar contactos, mostrar botones Follow
 * 5. Al pulsar Follow → guardar estado pendiente, redirigir a Amber para firmar
 * 6. Amber devuelve evento firmado como query param
 * 7. Publicar evento firmado a relays
 */

(function () {
    'use strict';

    // ─── Config ──────────────────────────────────────────────
    const RELAYS = [
        'wss://relay.damus.io',
        'wss://relay.nostr.band',
        'wss://nos.lol',
    ];
    const RELAY_TIMEOUT = 5000;
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

    // ─── Bech32 → Hex (same as nostr-follow.js) ─────────────
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

    function publishToRelays(event) {
        return Promise.all(RELAYS.map(url => {
            return new Promise((resolve) => {
                let ws, settled = false;
                const timeout = setTimeout(() => {
                    if (!settled) { settled = true; try { ws.close(); } catch {} resolve(false); }
                }, RELAY_TIMEOUT);
                try { ws = new WebSocket(url); } catch { clearTimeout(timeout); resolve(false); return; }
                ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'OK' && !settled) {
                            settled = true; clearTimeout(timeout); ws.close(); resolve(data[2] === true);
                        }
                    } catch {}
                };
                ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(false); } };
            });
        }));
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
            // Cache in sessionStorage for persistence across Amber round-trips
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
        // Save pending follow state so we can complete after Amber returns
        try {
            sessionStorage.setItem(STORAGE_KEY_PENDING, targetHex);
        } catch {}

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

        // Check not already following
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
        amberSignEvent(eventJson, targetHex);
    }

    // ─── Handle Amber callbacks ──────────────────────────────
    async function handleAmberReturn() {
        const params = new URLSearchParams(window.location.search);

        // ── Callback: get_public_key ──
        const pubkey = params.get('amber_pubkey');
        if (pubkey) {
            userPubkeyHex = pubkey;
            try { sessionStorage.setItem(STORAGE_KEY_PUBKEY, pubkey); } catch {}
            // Clean URL
            window.history.replaceState({}, '', CALLBACK_BASE);
            return 'pubkey';
        }

        // ── Callback: sign_event ──
        const eventParam = params.get('amber_event');
        if (eventParam) {
            // Clean URL first
            window.history.replaceState({}, '', CALLBACK_BASE);

            let signedEvent;
            try {
                // Amber may return gzip or plain JSON
                if (eventParam.startsWith('Signer1')) {
                    // gzip compressed — decode
                    const b64 = eventParam.slice(7);
                    const binary = atob(b64);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    const ds = new DecompressionStream('gzip');
                    const reader = new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
                    signedEvent = JSON.parse(await reader);
                } else {
                    signedEvent = JSON.parse(decodeURIComponent(eventParam));
                }
            } catch (err) {
                console.error('Error parsing Amber response:', err);
                return 'error';
            }

            // Publish to relays
            const results = await publishToRelays(signedEvent);
            const success = results.some(r => r === true);

            if (success) {
                const pendingHex = sessionStorage.getItem(STORAGE_KEY_PENDING);
                if (pendingHex) {
                    userContacts.add(pendingHex);
                    userContactEvent = signedEvent;
                    try {
                        sessionStorage.setItem(STORAGE_KEY_CONTACTS, JSON.stringify([...userContacts]));
                        sessionStorage.setItem(STORAGE_KEY_CONTACT_EVENT, JSON.stringify(signedEvent));
                        sessionStorage.removeItem(STORAGE_KEY_PENDING);
                    } catch {}
                }
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
                text-decoration: none;
                display: inline-flex;
                align-items: center;
                gap: 0.4rem;
            }

            .amber-connect-btn:hover {
                background: #e8850f;
            }

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
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #f7931a;
                flex-shrink: 0;
            }

            .amber-login-bar .user-npub {
                font-family: monospace;
                font-size: 0.75rem;
                color: var(--text-secondary);
            }

            .amber-disconnect-btn {
                padding: 0.3rem 0.6rem;
                border: 1px solid var(--border);
                background: transparent;
                color: var(--text-secondary);
                border-radius: 6px;
                font-family: inherit;
                font-size: 0.7rem;
                cursor: pointer;
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
                transition: background 0.2s, opacity 0.2s;
                white-space: nowrap;
            }

            .follow-btn-amber:hover:not(:disabled) {
                background: #e8850f;
            }

            .follow-btn-amber:disabled {
                cursor: default;
            }

            .follow-btn-amber.following {
                background: transparent;
                color: var(--success);
                border-color: var(--success);
            }

            .amber-toast {
                position: fixed;
                bottom: 2rem;
                left: 50%;
                transform: translateX(-50%);
                padding: 0.75rem 1.5rem;
                background: var(--bg-tertiary);
                border: 1px solid var(--success);
                border-radius: 10px;
                color: var(--success);
                font-size: 0.85rem;
                font-weight: 600;
                z-index: 1000;
                animation: fadeInUp 0.3s ease;
            }

            .amber-toast.error {
                border-color: #f87171;
                color: #f87171;
            }

            @keyframes fadeInUp {
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
            <button class="amber-connect-btn" id="amber-connect-btn">
                🔑 Conectar con Amber
            </button>
        `;
        container.parentNode.insertBefore(bar, container);

        document.getElementById('amber-connect-btn').addEventListener('click', (e) => {
            e.preventDefault();
            amberGetPublicKey();
        });
    }

    function showLoginBar(pubkeyHex) {
        // Remove connect bar if exists
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
            if (card.querySelector('.follow-btn-amber')) return;

            const link = card.querySelector('.profile-link a');
            if (!link) return;

            const href = link.getAttribute('href');
            const npubMatch = href.match(/(npub1[a-z0-9]{58})/i);
            if (!npubMatch) return;

            const npub = npubMatch[1];
            const hex = npubToHex(npub);
            if (!hex) return;

            // Don't show follow button for own profile
            if (hex === userPubkeyHex) return;

            const isFollowing = userContacts.has(hex);

            const btn = document.createElement('button');
            btn.className = 'follow-btn-amber' + (isFollowing ? ' following' : '');
            btn.textContent = isFollowing ? '✓ Siguiendo' : 'Follow';
            btn.disabled = isFollowing;
            btn.dataset.hex = hex;

            btn.addEventListener('click', () => followWithAmber(hex, btn));

            const linkParent = card.querySelector('.profile-link');
            if (linkParent) {
                linkParent.classList.add('profile-actions');
                linkParent.insertBefore(btn, linkParent.firstChild);
            }
        });
    }

    // ─── Init ────────────────────────────────────────────────
    async function init() {
        // Only activate on Android without NIP-07
        // Wait a bit for NIP-07 extensions
        await new Promise(r => setTimeout(r, 700));

        if (hasNip07()) {
            // nostr-follow.js handles this
            return;
        }

        if (!isAndroid()) {
            // Desktop without extension — nostr-follow.js handles (or nothing)
            return;
        }

        injectStyles();

        // Check for Amber callbacks FIRST
        const callbackResult = await handleAmberReturn();

        if (callbackResult === 'follow_ok') {
            showToast('✓ Follow realizado con éxito');
        } else if (callbackResult === 'follow_error') {
            showToast('✗ Error al publicar el follow', true);
        }

        // Check for saved session
        if (!userPubkeyHex) {
            try {
                userPubkeyHex = sessionStorage.getItem(STORAGE_KEY_PUBKEY);
            } catch {}
        }

        if (userPubkeyHex) {
            amberReady = true;
            showLoginBar(userPubkeyHex);

            // Try cached contacts first, then refresh from relays
            const hasCached = loadCachedContacts();
            if (hasCached) {
                addFollowButtons();
            }

            // Refresh from relays (non-blocking)
            loadUserContacts().then(() => {
                // Re-render buttons with fresh data
                document.querySelectorAll('.follow-btn-amber').forEach(b => b.remove());
                addFollowButtons();
            });
        } else {
            showConnectBar();
        }

        // Observe DOM changes (search filter re-renders)
        const observer = new MutationObserver(() => {
            if (amberReady) setTimeout(addFollowButtons, 50);
        });
        const directory = document.getElementById('directory');
        if (directory) {
            observer.observe(directory, { childList: true });
        }
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
