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
        'wss://relay.nostr.band',
        'wss://nos.lol',
    ];
    const RELAY_TIMEOUT = 5000; // ms para esperar respuesta de cada relay
    const NIP07_DETECT_DELAY = 600; // ms para esperar inyección de extensión

    // ─── State ───────────────────────────────────────────────
    let userPubkeyHex = null;
    let userContacts = new Set(); // hex pubkeys que el usuario ya sigue
    let userContactEvent = null; // evento kind 3 completo (para preservar tags)
    let nostrReady = false;

    // ─── Bech32 → Hex ────────────────────────────────────────
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

    function bech32Decode(str) {
        str = str.toLowerCase();
        const pos = str.lastIndexOf('1');
        if (pos < 1) return null;

        const hrp = str.slice(0, pos);
        const dataChars = str.slice(pos + 1);

        const data = [];
        for (let i = 0; i < dataChars.length; i++) {
            const idx = CHARSET.indexOf(dataChars[i]);
            if (idx === -1) return null;
            data.push(idx);
        }

        // Remove checksum (last 6)
        const values = data.slice(0, -6);
        // Convert from 5-bit to 8-bit
        return { hrp, data: convertBits(values, 5, 8, false) };
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

        if (pad) {
            if (bits > 0) result.push((acc << (toBits - bits)) & maxv);
        }
        return result;
    }

    function npubToHex(npub) {
        try {
            const decoded = bech32Decode(npub);
            if (!decoded || decoded.hrp !== 'npub') return null;
            return decoded.data.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch {
            return null;
        }
    }

    // ─── Relay communication ─────────────────────────────────
    function queryRelay(relayUrl, filter) {
        return new Promise((resolve, reject) => {
            let ws;
            const subId = 'nf_' + Math.random().toString(36).slice(2, 8);
            const events = [];
            let settled = false;

            const timeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    try { ws.close(); } catch {}
                    resolve(events);
                }
            }, RELAY_TIMEOUT);

            try {
                ws = new WebSocket(relayUrl);
            } catch {
                clearTimeout(timeout);
                resolve(events);
                return;
            }

            ws.onopen = () => {
                ws.send(JSON.stringify(['REQ', subId, filter]));
            };

            ws.onmessage = (msg) => {
                try {
                    const data = JSON.parse(msg.data);
                    if (data[0] === 'EVENT' && data[1] === subId) {
                        events.push(data[2]);
                    } else if (data[0] === 'EOSE' && data[1] === subId) {
                        if (!settled) {
                            settled = true;
                            clearTimeout(timeout);
                            ws.close();
                            resolve(events);
                        }
                    }
                } catch {}
            };

            ws.onerror = () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    resolve(events);
                }
            };
        });
    }

    function publishToRelays(event) {
        const promises = RELAYS.map(url => {
            return new Promise((resolve) => {
                let ws;
                let settled = false;

                const timeout = setTimeout(() => {
                    if (!settled) { settled = true; try { ws.close(); } catch {} resolve(false); }
                }, RELAY_TIMEOUT);

                try {
                    ws = new WebSocket(url);
                } catch {
                    clearTimeout(timeout);
                    resolve(false);
                    return;
                }

                ws.onopen = () => {
                    ws.send(JSON.stringify(['EVENT', event]));
                };

                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'OK') {
                            if (!settled) {
                                settled = true;
                                clearTimeout(timeout);
                                ws.close();
                                resolve(data[2] === true);
                            }
                        }
                    } catch {}
                };

                ws.onerror = () => {
                    if (!settled) { settled = true; clearTimeout(timeout); resolve(false); }
                };
            });
        });

        return Promise.all(promises);
    }

    // ─── Contact list (kind 3) ───────────────────────────────
    async function fetchContactList(pubkeyHex) {
        const filter = { kinds: [3], authors: [pubkeyHex], limit: 1 };

        // Query all relays in parallel, take the newest event
        const results = await Promise.all(
            RELAYS.map(url => queryRelay(url, filter))
        );

        let newest = null;
        for (const events of results) {
            for (const ev of events) {
                if (!newest || ev.created_at > newest.created_at) {
                    newest = ev;
                }
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
                event.tags
                    .filter(t => t[0] === 'p')
                    .map(t => t[1])
            );
        }
    }

    // ─── Follow action ──────────────────────────────────────
    async function followUser(targetHex, button) {
        if (!window.nostr || !userPubkeyHex) return;

        button.disabled = true;
        button.textContent = '⏳';

        try {
            // Build new contact list
            let tags = [];
            if (userContactEvent && userContactEvent.tags) {
                tags = [...userContactEvent.tags];
            }

            // Check not already following
            const alreadyFollows = tags.some(t => t[0] === 'p' && t[1] === targetHex);
            if (alreadyFollows) {
                button.textContent = '✓ Siguiendo';
                button.classList.add('following');
                return;
            }

            // Add new contact
            tags.push(['p', targetHex]);

            const event = {
                kind: 3,
                created_at: Math.floor(Date.now() / 1000),
                tags: tags,
                content: userContactEvent ? userContactEvent.content : '',
            };

            // Sign with extension
            const signed = await window.nostr.signEvent(event);

            // Publish
            const results = await publishToRelays(signed);
            const success = results.some(r => r === true);

            if (success) {
                userContacts.add(targetHex);
                userContactEvent = signed;
                button.textContent = '✓ Siguiendo';
                button.classList.add('following');
                button.disabled = true;
            } else {
                button.textContent = '✗ Error';
                button.disabled = false;
                setTimeout(() => {
                    button.textContent = 'Follow';
                    button.classList.remove('following');
                }, 2000);
            }
        } catch (err) {
            console.error('Follow error:', err);
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

            .follow-all-btn {
                padding: 0.5rem 1.2rem;
                border: 1px solid var(--accent);
                background: transparent;
                color: var(--accent);
                border-radius: 8px;
                font-family: inherit;
                font-size: 0.8rem;
                font-weight: 600;
                cursor: pointer;
                transition: background 0.2s, color 0.2s;
            }

            .follow-all-btn:hover {
                background: var(--accent);
                color: #fff;
            }

            .profile-actions {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                flex-shrink: 0;
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
            // Skip if already has follow button
            if (card.querySelector('.follow-btn')) return;

            const npubEl = card.querySelector('.profile-npub');
            if (!npubEl) return;

            // Get full npub from the profile link
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
            btn.className = 'follow-btn' + (isFollowing ? ' following' : '');
            btn.textContent = isFollowing ? '✓ Siguiendo' : 'Follow';
            btn.disabled = isFollowing;
            btn.dataset.hex = hex;

            btn.addEventListener('click', () => followUser(hex, btn));

            // Wrap existing link + button in actions container
            const linkParent = card.querySelector('.profile-link');
            if (linkParent) {
                linkParent.classList.add('profile-actions');
                linkParent.insertBefore(btn, linkParent.firstChild);
            }
        });
    }

    // ─── Init ────────────────────────────────────────────────
    async function init() {
        // Wait for extension to inject window.nostr
        await new Promise(r => setTimeout(r, NIP07_DETECT_DELAY));

        if (!window.nostr) {
            // No extension — do nothing, page stays as-is
            return;
        }

        try {
            userPubkeyHex = await window.nostr.getPublicKey();
        } catch {
            // User denied permission
            return;
        }

        if (!userPubkeyHex) return;

        nostrReady = true;
        injectStyles();
        showLoginBar(userPubkeyHex);

        // Load contacts then add buttons
        await loadUserContacts();
        addFollowButtons();

        // Re-add buttons when profiles are re-rendered (search filter)
        const observer = new MutationObserver(() => {
            if (nostrReady) {
                setTimeout(addFollowButtons, 50);
            }
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

    // Expose for debugging
    window._nostrFollow = { npubToHex, userContacts: () => userContacts };
})();
