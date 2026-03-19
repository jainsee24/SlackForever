/* ── Slack Archive Viewer — Frontend ── */

const state = {
    channels: [],
    users: {},
    currentChannel: null,
    messages: [],
    oldestTs: null,
    searchTimeout: null,
    currentUserId: null,
    emojiPickerCallback: null,
    emojiPickerTarget: null,
    editingMessageTs: null,
    channelDetailOpen: false,
    frequentEmojis: JSON.parse(localStorage.getItem('frequentEmojis') || '[]'),
    typingTimeout: null,
    mentionIndex: -1,
    emojiAutocompleteIndex: -1,
    mentionMap: {},
    activeTextarea: null,  // tracks which textarea has focus (main or edit)
};

// ── Init ──
document.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    setupDragDrop();
    await loadCurrentUser();
    await checkSetupStatus();
});

// ── API helpers ──
async function api(url) {
    const resp = await fetch(url);
    return resp.json();
}

// ══════════════════════════════════════════
// ── Current User ──
// ══════════════════════════════════════════
async function loadCurrentUser() {
    try {
        const me = await api('/api/me');
        if (me && me.user_id) {
            state.currentUserId = me.user_id;
        }
    } catch (e) {
        // not critical
    }
}

function get_active_workspace_id() {
    // Try to get from setup status cache or workspaces API
    try {
        const ws = document.getElementById('workspace-name');
        // Use the workspace ID from the setup status (cached in state)
        return state.activeWorkspaceId || '';
    } catch (e) { return ''; }
}

// ══════════════════════════════════════════
// ── Emoji Rendering ──
// ══════════════════════════════════════════
function renderEmoji(shortcode) {
    if (typeof EMOJI_DATA !== 'undefined' && EMOJI_DATA[shortcode]) {
        return EMOJI_DATA[shortcode];
    }
    return `<span class="emoji" title=":${shortcode}:">:${shortcode}:</span>`;
}

function getEmojiUnicode(shortcode) {
    if (typeof EMOJI_DATA !== 'undefined' && EMOJI_DATA[shortcode]) {
        return EMOJI_DATA[shortcode];
    }
    return `:${shortcode}:`;
}

function getEmojiCategories() {
    if (typeof EMOJI_DATA === 'undefined') return {};
    const cats = {
        'Frequently Used': [],
        'Smileys & People': [],
        'Animals & Nature': [],
        'Food & Drink': [],
        'Activity': [],
        'Travel & Places': [],
        'Objects': [],
        'Symbols': [],
        'Flags': []
    };
    cats['Frequently Used'] = state.frequentEmojis.slice(0, 24);
    const allEmojis = Object.keys(EMOJI_DATA);
    const perCat = Math.ceil(allEmojis.length / 8);
    const catNames = Object.keys(cats).filter(c => c !== 'Frequently Used');
    catNames.forEach((name, i) => {
        cats[name] = allEmojis.slice(i * perCat, (i + 1) * perCat);
    });
    return cats;
}

function trackFrequentEmoji(shortcode) {
    let freq = state.frequentEmojis.filter(e => e !== shortcode);
    freq.unshift(shortcode);
    freq = freq.slice(0, 32);
    state.frequentEmojis = freq;
    localStorage.setItem('frequentEmojis', JSON.stringify(freq));
}

// ══════════════════════════════════════════
// ── Setup Wizard ──
// ══════════════════════════════════════════

async function checkSetupStatus() {
    try {
        const status = await api('/api/setup/status');
        // Store workspace ID for huddle links etc
        if (status.active_workspace) state.activeWorkspaceId = status.active_workspace;

        if (!status.has_token && !status.sync_running) {
            showSetupWizard();
            return;
        }

        if (status.has_data || status.sync_running) {
            hideSetupWizard();
            loadWorkspace();
            loadChannels();
            loadUsers();

            if (status.sync_running) {
                startSyncPolling();
            }

            if (status.last_synced && !status.sync_running) {
                const lastSync = new Date(status.last_synced);
                const daysSince = Math.floor((Date.now() - lastSync) / (1000 * 60 * 60 * 24));
                if (daysSince >= 7) {
                    showStaleSyncWarning(daysSince, status.last_synced);
                }
            }
            return;
        }

        if (status.has_token && !status.has_data) {
            showSetupWizard();
            setupGoToStep(3);
            document.getElementById('setup-token-input').value = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
            document.getElementById('setup-token-input').disabled = true;
            const result = document.getElementById('setup-result');
            result.style.display = 'block';
            result.className = 'setup-result success';
            result.innerHTML = `Token already configured (${status.token_preview || 'xoxc-...'}).<br>Click <strong>Connect & Start Syncing</strong> to download your messages.`;
        }
    } catch (e) {
        hideSetupWizard();
        loadWorkspace();
        loadChannels();
        loadUsers();
    }
}

function showSetupWizard() {
    document.getElementById('setup-wizard').style.display = 'flex';
    const topbar = document.getElementById('app').querySelector('.topbar');
    const main = document.getElementById('app').querySelector('.main-container');
    if (topbar) topbar.style.display = 'none';
    if (main) main.style.display = 'none';
}

function hideSetupWizard() {
    document.getElementById('setup-wizard').style.display = 'none';
    const topbar = document.getElementById('app').querySelector('.topbar');
    const main = document.getElementById('app').querySelector('.main-container');
    if (topbar) topbar.style.display = '';
    if (main) main.style.display = '';
}

let setupMethod = 'browser';

function chooseMethod(method) {
    setupMethod = method;
    setupGoToStep(2);
}

function setupGoToStep(step) {
    const allPanels = ['setup-step-1', 'setup-step-browser', 'setup-step-app', 'setup-step-3', 'setup-step-done'];
    allPanels.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });

    if (step === 1) {
        document.getElementById('setup-step-1').style.display = 'block';
    } else if (step === 2) {
        if (setupMethod === 'browser') {
            document.getElementById('setup-step-browser').style.display = 'block';
        } else {
            document.getElementById('setup-step-app').style.display = 'block';
        }
    } else if (step === 3) {
        document.getElementById('setup-step-3').style.display = 'block';
        const cookieField = document.getElementById('cookie-field');
        if (setupMethod === 'browser') {
            cookieField.style.display = 'flex';
            document.getElementById('setup-token-input').placeholder = 'xoxc-...';
        } else {
            cookieField.style.display = 'none';
            document.getElementById('setup-token-input').placeholder = 'xoxp-...';
        }
    }

    document.querySelectorAll('.setup-step').forEach(el => {
        const s = parseInt(el.dataset.step);
        el.classList.remove('active', 'done');
        if (s === step) el.classList.add('active');
        else if (s < step) el.classList.add('done');
    });
}

function copyScript() {
    const code = document.getElementById('token-script').textContent;
    navigator.clipboard.writeText(code).then(() => {
        const btn = document.querySelector('.btn-copy');
        btn.innerHTML = '<span style="color:#4caf50">Copied!</span>';
        setTimeout(() => {
            btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
        }, 2000);
    });
}

async function connectSlack() {
    const tokenInput = document.getElementById('setup-token-input');
    const cookieInput = document.getElementById('setup-cookie-input');
    const resultDiv = document.getElementById('setup-result');
    const btnConnect = document.getElementById('btn-connect');
    const textSpan = btnConnect.querySelector('.btn-connect-text');
    const spinnerSpan = btnConnect.querySelector('.btn-connect-spinner');

    let token = tokenInput.value.trim();
    let cookie = cookieInput ? cookieInput.value.trim() : '';
    let alreadySaved = tokenInput.disabled;

    if (!token && !alreadySaved) {
        resultDiv.style.display = 'block';
        resultDiv.className = 'setup-result error';
        resultDiv.textContent = 'Please paste your Slack token above.';
        return;
    }

    if (token.startsWith('xoxc-') && !cookie) {
        resultDiv.style.display = 'block';
        resultDiv.className = 'setup-result error';
        resultDiv.textContent = 'Browser tokens (xoxc-) require the "d" cookie value. Please paste it in the cookie field.';
        return;
    }

    textSpan.style.display = 'none';
    spinnerSpan.style.display = 'flex';
    btnConnect.disabled = true;
    resultDiv.style.display = 'none';

    try {
        if (!alreadySaved) {
            const resp = await fetch('/api/setup/save-token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, cookie })
            });
            const data = await resp.json();

            if (data.error) {
                resultDiv.style.display = 'block';
                resultDiv.className = 'setup-result error';
                resultDiv.textContent = data.error;
                textSpan.style.display = '';
                spinnerSpan.style.display = 'none';
                btnConnect.disabled = false;
                return;
            }

            document.getElementById('setup-done-team').textContent =
                `Connected to ${data.team} as ${data.user}`;
        } else {
            document.getElementById('setup-done-team').textContent = 'Connected to your workspace';
        }

        ['setup-step-1', 'setup-step-browser', 'setup-step-app', 'setup-step-3'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        document.getElementById('setup-step-done').style.display = 'block';
        document.querySelectorAll('.setup-step').forEach(el => el.classList.add('done'));
        document.querySelectorAll('.setup-step').forEach(el => el.classList.remove('active'));

        loadChannelPicker('setup');

    } catch (e) {
        resultDiv.style.display = 'block';
        resultDiv.className = 'setup-result error';
        resultDiv.textContent = `Connection error: ${e.message}`;
    }

    textSpan.style.display = '';
    spinnerSpan.style.display = 'none';
    btnConnect.disabled = false;
}

// ══════════════════════════════════════════
// ── Channel Picker ──
// ══════════════════════════════════════════
let pickerChannels = [];

async function loadChannelPicker(context) {
    const container = context === 'setup'
        ? document.getElementById('setup-channel-picker')
        : document.getElementById('modal-channel-picker');
    if (!container) return;

    container.innerHTML = '<p style="color:#999;text-align:center;padding:16px">Loading channels from Slack...</p>';
    container.style.display = 'block';

    if (context === 'setup') {
        document.getElementById('setup-sync-progress-area').style.display = 'none';
        document.getElementById('btn-start-selected-sync').style.display = '';
    }

    try {
        pickerChannels = await api('/api/sync/channels');
        renderChannelPicker(container, context);
    } catch (e) {
        container.innerHTML = `<p style="color:#c62828;padding:12px">Failed to load channels: ${e.message}</p>`;
    }
}

function renderChannelPicker(container, context) {
    const channels = pickerChannels.filter(c => !c.is_dm && !c.is_group_dm && !c.is_archived);
    const dms = pickerChannels.filter(c => c.is_dm);
    const groups = pickerChannels.filter(c => c.is_group_dm);

    container.innerHTML = `
        <div class="picker-controls">
            <button class="picker-btn active" data-filter="channels" onclick="filterPicker(this,'channels')">Channels (${channels.length})</button>
            <button class="picker-btn" data-filter="dms" onclick="filterPicker(this,'dms')">DMs (${dms.length})</button>
            ${groups.length ? `<button class="picker-btn" data-filter="groups" onclick="filterPicker(this,'groups')">Group DMs (${groups.length})</button>` : ''}
            <span class="picker-spacer"></span>
            <button class="picker-select-btn" onclick="toggleAllPicker(true)">Select All</button>
            <button class="picker-select-btn" onclick="toggleAllPicker(false)">None</button>
        </div>
        <div class="picker-list" id="picker-list">
            ${renderPickerSection('channels', channels, true)}
            ${renderPickerSection('dms', dms, false)}
            ${renderPickerSection('groups', groups, false)}
        </div>
        <div class="picker-summary" id="picker-summary"></div>
    `;
    updatePickerSummary();
}

function renderPickerSection(type, items, visible) {
    if (items.length === 0) return '';
    return `<div class="picker-section" data-type="${type}" style="display:${visible ? 'block' : 'none'}">
        ${items.map(ch => `
            <label class="picker-item" data-id="${ch.id}">
                <input type="checkbox" checked value="${ch.id}" onchange="updatePickerSummary()">
                <span class="picker-icon">${ch.is_dm ? '\u{1F4AC}' : ch.is_group_dm ? '\u{1F465}' : ch.is_private ? '\u{1F512}' : '#'}</span>
                <span class="picker-name">${escapeHtml(ch.display_name || ch.name)}</span>
                ${ch.num_members ? `<span class="picker-members">${ch.num_members} members</span>` : ''}
            </label>
        `).join('')}
    </div>`;
}

function filterPicker(btn, type) {
    document.querySelectorAll('.picker-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.picker-section').forEach(s => {
        s.style.display = s.dataset.type === type ? 'block' : 'none';
    });
}

function toggleAllPicker(checked) {
    const active = document.querySelector('.picker-btn.active');
    const type = active?.dataset.filter || 'channels';
    const section = document.querySelector(`.picker-section[data-type="${type}"]`);
    if (section) {
        section.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = checked; });
    }
    updatePickerSummary();
}

function updatePickerSummary() {
    const all = document.querySelectorAll('#picker-list input[type=checkbox]');
    const checked = document.querySelectorAll('#picker-list input[type=checkbox]:checked');
    const summary = document.getElementById('picker-summary');
    if (summary) {
        summary.textContent = `${checked.length} of ${all.length} selected`;
    }
}

function getSelectedChannelIds() {
    const checked = document.querySelectorAll('#picker-list input[type=checkbox]:checked');
    return Array.from(checked).map(cb => cb.value);
}

async function startSelectedSync(context) {
    const ids = getSelectedChannelIds();
    if (ids.length === 0) {
        alert('Please select at least one channel to sync.');
        return;
    }

    const resp = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_ids: ids })
    });
    const data = await resp.json();

    if (data.error) {
        alert('Sync error: ' + data.error);
        return;
    }

    if (context === 'setup') {
        document.getElementById('setup-channel-picker').style.display = 'none';
        document.getElementById('btn-start-selected-sync').style.display = 'none';
        document.getElementById('setup-sync-progress-area').style.display = 'block';
        pollSetupSync();
    } else {
        document.getElementById('sync-modal').style.display = 'none';
        startSyncPolling();
    }
}

async function pollSetupSync() {
    const statusText = document.getElementById('setup-sync-status');
    const bar = document.getElementById('setup-sync-bar');
    const enterBtn = document.getElementById('btn-enter-app');
    let elapsed = 0;

    const poll = setInterval(async () => {
        elapsed++;
        try {
            const status = await api('/api/sync/status');

            let text = status.progress || 'Working...';
            if (status.messages_synced > 0) {
                text += ` (${status.messages_synced.toLocaleString()} messages)`;
            }
            statusText.textContent = text;

            const pct = status.percent || 0;
            bar.style.width = `${pct}%`;

            if (elapsed > 4 || status.phase === 'messages' || !status.running) {
                enterBtn.style.display = 'block';
            }

            if (!status.running) {
                clearInterval(poll);
                bar.style.width = '100%';
                if (status.error) {
                    statusText.textContent = `Error: ${status.error}`;
                    statusText.style.color = '#c62828';
                } else {
                    statusText.textContent = `Sync complete! ${(status.messages_synced || 0).toLocaleString()} messages archived. Downloading media...`;
                    statusText.style.color = '#007a5a';
                    // Auto-download media after sync
                    autoDownloadMediaAfterSync();
                }
                enterBtn.textContent = 'Open Archive Viewer \u2192';
                enterBtn.style.display = 'block';
            }
        } catch (e) {
            // ignore
        }
    }, 2000);
}

// ══════════════════════════════════════════
// ── Live Sync Indicator (main app) ──
// ══════════════════════════════════════════
let syncPollInterval = null;

function startSyncPolling() {
    showSyncBanner();
    if (syncPollInterval) clearInterval(syncPollInterval);

    syncPollInterval = setInterval(async () => {
        try {
            const status = await api('/api/sync/status');
            updateSyncBanner(status);

            if (!status.running) {
                clearInterval(syncPollInterval);
                syncPollInterval = null;

                setTimeout(() => {
                    loadChannels();
                    loadUsers();
                    if (state.currentChannel) {
                        loadMessages(state.currentChannel.id, false);
                    }
                    hideSyncBanner();
                }, 1500);
            }
        } catch (e) { /* ignore */ }
    }, 2000);
}

function showSyncBanner() {
    let banner = document.getElementById('sync-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'sync-banner';
        banner.className = 'sync-banner';
        banner.innerHTML = `
            <div class="sync-banner-inner">
                <div class="sync-banner-spinner"></div>
                <span class="sync-banner-text">Syncing...</span>
                <div class="sync-banner-bar-bg"><div class="sync-banner-bar" id="sync-banner-bar"></div></div>
                <span class="sync-banner-pct" id="sync-banner-pct">0%</span>
            </div>
        `;
        const chatArea = document.querySelector('.chat-area');
        chatArea.insertBefore(banner, chatArea.querySelector('.messages-container'));
    }
    banner.style.display = 'block';
}

function updateSyncBanner(status) {
    const text = document.querySelector('.sync-banner-text');
    const bar = document.getElementById('sync-banner-bar');
    const pct = document.getElementById('sync-banner-pct');
    if (!text) return;

    let label = status.progress || 'Syncing...';
    if (status.messages_synced > 0) {
        label = `${status.channel_name ? '#' + status.channel_name : 'Syncing'} \u2014 ${status.messages_synced.toLocaleString()} msgs`;
    }
    text.textContent = label;
    const p = status.percent || 0;
    if (bar) bar.style.width = `${p}%`;
    if (pct) pct.textContent = `${p}%`;

    if (!status.running && !status.error) {
        text.textContent = `Sync complete! ${(status.messages_synced || 0).toLocaleString()} messages — downloading media...`;
        if (pct) pct.textContent = '100%';
        if (bar) bar.style.width = '100%';
        // Auto-download media
        autoDownloadMediaAfterSync();
    }
    if (status.error) {
        text.textContent = `Sync error: ${status.error}`;
        text.style.color = '#c62828';
    }
}

function hideSyncBanner() {
    const banner = document.getElementById('sync-banner');
    if (banner) {
        banner.style.opacity = '0';
        setTimeout(() => banner.remove(), 500);
    }
}

function showStaleSyncWarning(daysSince, lastSyncDate) {
    const d = new Date(lastSyncDate);
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const daysLeft = Math.max(0, 90 - daysSince);
    const urgency = daysSince >= 60 ? 'urgent' : daysSince >= 30 ? 'warning' : 'info';
    const colors = {
        urgent: { bg: '#fce4ec', border: '#ef9a9a', text: '#c62828', icon: '\u{1F6A8}' },
        warning: { bg: '#fff8e1', border: '#ffe082', text: '#f57f17', icon: '\u26A0\uFE0F' },
        info: { bg: '#e3f2fd', border: '#90caf9', text: '#1565c0', icon: '\u{1F4A1}' },
    };
    const c = colors[urgency];

    let banner = document.getElementById('stale-sync-banner');
    if (banner) banner.remove();

    banner = document.createElement('div');
    banner.id = 'stale-sync-banner';
    banner.style.cssText = `background:${c.bg};border-bottom:1px solid ${c.border};padding:10px 20px;display:flex;align-items:center;gap:10px;font-size:13px;color:${c.text};flex-shrink:0;`;
    banner.innerHTML = `
        <span>${c.icon}</span>
        <span style="flex:1">
            <strong>Last synced ${daysSince} days ago</strong> (${dateStr}).
            ${daysLeft > 0
                ? `Messages older than ${daysLeft} days from now will be lost if not synced soon.`
                : `Some messages may have already expired from Slack!`}
        </span>
        <button onclick="document.getElementById('btn-sync').click();this.closest('#stale-sync-banner').remove()"
                style="background:${c.text};color:#fff;border:none;padding:6px 14px;border-radius:6px;font-weight:700;font-size:12px;cursor:pointer;white-space:nowrap">
            Sync Now
        </button>
        <button onclick="this.closest('#stale-sync-banner').remove()"
                style="background:none;border:none;font-size:18px;cursor:pointer;color:${c.text};padding:0 4px">\u00D7</button>
    `;

    const chatArea = document.querySelector('.chat-area');
    chatArea.insertBefore(banner, chatArea.querySelector('.chat-header').nextSibling);
}

function enterApp() {
    hideSetupWizard();
    loadWorkspace();
    loadChannels();
    loadUsers();
    startTokenHealthCheck();
}

// ── Workspace ──
async function loadWorkspace() {
    const ws = await api('/api/workspace');
    document.getElementById('workspace-name').textContent = ws.name || 'Slack Archive';
    const icon = document.getElementById('workspace-icon');
    if (ws.icon_url) {
        icon.innerHTML = `<img src="${ws.icon_url}" style="width:100%;height:100%;border-radius:6px">`;
    } else {
        icon.textContent = (ws.name || 'S')[0].toUpperCase();
    }
    document.title = `${ws.name || 'Slack'} Archive`;

    loadWorkspaceSwitcher();
}

async function loadWorkspaceSwitcher() {
    try {
        const data = await api('/api/workspaces');
        const caret = document.getElementById('ws-caret');
        if (data.workspaces.length > 1) {
            caret.style.display = '';
        } else {
            caret.style.display = 'none';
        }

        const list = document.getElementById('ws-dropdown-list');
        list.innerHTML = data.workspaces.map(ws => `
            <div class="ws-dropdown-item ${ws.id === data.active ? 'active' : ''}"
                 onclick="switchWorkspace('${ws.id}')">
                <div class="ws-item-icon">${(ws.name || 'S')[0].toUpperCase()}</div>
                <div>
                    <div class="ws-item-name">${escapeHtml(ws.name)}</div>
                    <div class="ws-item-user">${escapeHtml(ws.user || ws.domain || '')}</div>
                </div>
                ${ws.id === data.active ? '<span class="ws-item-check">\u2713</span>' : ''}
            </div>
        `).join('');

        if (data.workspaces.length >= 1) {
            caret.style.display = '';
        }
    } catch (e) {
        // ignore
    }
}

async function switchWorkspace(teamId) {
    document.getElementById('ws-dropdown').style.display = 'none';
    const resp = await fetch('/api/workspaces/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: teamId })
    });
    const data = await resp.json();
    if (data.success) {
        loadWorkspace();
        loadChannels();
        loadUsers();
        state.currentChannel = null;
        document.getElementById('messages-list').innerHTML = '';
        document.getElementById('channel-title').textContent = 'Select a channel';
        document.getElementById('channel-topic').textContent = '';
    }
}

function showSetupWizardForNewWorkspace() {
    document.getElementById('ws-dropdown').style.display = 'none';
    showSetupWizard();
    setupGoToStep(1);
    const ti = document.getElementById('setup-token-input');
    if (ti) { ti.value = ''; ti.disabled = false; }
    const ci = document.getElementById('setup-cookie-input');
    if (ci) ci.value = '';
    const r = document.getElementById('setup-result');
    if (r) r.style.display = 'none';
}

// ── Channels ──
async function loadChannels() {
    state.channels = await api('/api/channels');

    const channelsList = document.getElementById('channels-list');
    const dmsList = document.getElementById('dms-list');
    channelsList.innerHTML = '';
    dmsList.innerHTML = '';

    let dmCount = 0, chCount = 0;

    state.channels.forEach(ch => {
        const li = document.createElement('li');
        li.className = 'channel-item';
        li.dataset.id = ch.id;

        if (ch.is_dm || ch.is_group_dm) {
            // For DMs, name is the user ID — store it for presence lookup
            const dmUserId = ch.name || '';
            li.dataset.userId = dmUserId;
            li.innerHTML = `
                <div class="dm-avatar">
                    ${ch.avatar ? `<img src="${ch.avatar}" alt="">` : '<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:11px;color:#cfc3cf">' + (ch.display_name || '?')[0].toUpperCase() + '</span>'}
                    <span class="presence-dot" data-user="${escapeHtml(dmUserId)}" style="display:none"></span>
                </div>
                <span class="channel-name">${escapeHtml(ch.display_name || ch.name)}</span>
            `;
            dmsList.appendChild(li);
            dmCount++;
        } else {
            const prefix = ch.is_private ? '\u{1F512}' : '#';
            li.innerHTML = `
                <span class="hash">${prefix}</span>
                <span class="channel-name">${escapeHtml(ch.name)}</span>
            `;
            channelsList.appendChild(li);
            chCount++;
        }

        li.addEventListener('click', () => selectChannel(ch));
    });

    const dmsCountEl = document.getElementById('dms-count');
    const chCountEl = document.getElementById('channels-count');
    if (dmsCountEl) dmsCountEl.textContent = dmCount > 0 ? `(${dmCount})` : '';
    if (chCountEl) chCountEl.textContent = chCount > 0 ? `(${chCount})` : '';

    // Fetch presence for DM users (in background, don't block)
    loadPresenceForDMs();
}

// ── Select Channel ──
async function selectChannel(channel) {
    state.currentChannel = channel;
    state.messages = [];
    state.oldestTs = null;

    document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`.channel-item[data-id="${channel.id}"]`)?.classList.add('active');

    const title = document.getElementById('channel-title');
    if (channel.is_dm) {
        title.textContent = channel.display_name || channel.name;
    } else {
        title.textContent = `${channel.is_private ? '\u{1F512} ' : '# '}${channel.name}`;
    }
    document.getElementById('channel-topic').textContent = channel.topic || '';

    // Show presence for DMs, member count for channels
    const memberCountEl = document.getElementById('member-count');
    if (channel.is_dm && channel.name) {
        const cached = presenceCache[channel.name];
        if (cached) {
            updateChatHeaderPresence(cached.online);
        } else {
            memberCountEl.textContent = '';
            // Fetch presence async
            api(`/api/users/${channel.name}/presence`).then(data => {
                if (data && !data.error) {
                    presenceCache[channel.name] = { online: data.online, ts: Date.now() };
                    if (state.currentChannel && state.currentChannel.id === channel.id) {
                        updateChatHeaderPresence(data.online);
                    }
                }
            }).catch(() => {});
        }
    } else {
        memberCountEl.textContent = channel.num_members ? `${channel.num_members} members` : '';
    }

    // Hide welcome screen
    const welcomeScreen = document.getElementById('welcome-screen');
    if (welcomeScreen) welcomeScreen.style.display = 'none';

    const msgList = document.getElementById('messages-list');
    msgList.innerHTML = '<div style="padding:40px;text-align:center;color:#999">Loading messages...</div>';

    // Close panels
    document.getElementById('thread-panel').style.display = 'none';
    closeChannelDetails();

    // Show composer
    const composer = document.getElementById('composer');
    if (composer) composer.style.display = '';

    // Show channel header buttons
    const detailBtn = document.getElementById('btn-channel-details');
    if (detailBtn) detailBtn.style.display = 'flex';
    const pinsBtn = document.getElementById('btn-pins');
    if (pinsBtn) pinsBtn.style.display = 'flex';
    const huddleBtn = document.getElementById('btn-huddle');
    if (huddleBtn) huddleBtn.style.display = 'flex';

    const msgInput = document.getElementById('message-input');
    if (msgInput) {
        msgInput.placeholder = `Message ${channel.is_dm ? (channel.display_name || '') : '#' + channel.name}`;
    }

    await loadMessages(channel.id, false);
    startLivePolling(channel.id);
}

// ── Load Messages ──
async function loadMessages(channelId, loadOlder = false) {
    let url = `/api/channels/${channelId}/messages?limit=80`;
    if (loadOlder && state.oldestTs) {
        url += `&before=${state.oldestTs}`;
    }

    const msgs = await api(url);
    if (!loadOlder) {
        state.messages = msgs;
    } else {
        state.messages = [...msgs, ...state.messages];
    }

    if (msgs.length > 0) {
        state.oldestTs = msgs[0].ts;
    }

    renderMessages();

    document.getElementById('load-more').style.display =
        msgs.length >= 80 ? 'block' : 'none';

    if (!loadOlder) {
        const scroll = document.getElementById('messages-scroll');
        scroll.scrollTop = scroll.scrollHeight;
    }
}

// ── SVG Icons ──
const ICONS = {
    reaction: '<svg viewBox="0 0 20 20" width="16" height="16"><path fill="currentColor" d="M10 2a8 8 0 110 16 8 8 0 010-16zm0 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM6.5 8a1 1 0 112 0 1 1 0 01-2 0zm5 0a1 1 0 112 0 1 1 0 01-2 0zm-5 3.5c0-.28.22-.5.5-.5h6c.28 0 .5.22.5.5a3.5 3.5 0 01-7 0z"/></svg>',
    thread: '<svg viewBox="0 0 20 20" width="16" height="16"><path fill="currentColor" d="M6.5 2h7A4.5 4.5 0 0118 6.5v3a4.5 4.5 0 01-4.5 4.5H11l-4.5 4V14H6.5A4.5 4.5 0 012 9.5v-3A4.5 4.5 0 016.5 2z"/></svg>',
    bookmark: '<svg viewBox="0 0 20 20" width="16" height="16"><path fill="currentColor" d="M5 3h10a1 1 0 011 1v13.5l-6-3.5-6 3.5V4a1 1 0 011-1z"/></svg>',
    more: '<svg viewBox="0 0 20 20" width="16" height="16"><path fill="currentColor" d="M4.5 10a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0zm5 0a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0zm5 0a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0z"/></svg>',
    send: '<svg viewBox="0 0 20 20" width="18" height="18"><path fill="currentColor" d="M1.5 2.25a.755.755 0 011-.71l15.596 7.808a.73.73 0 010 1.305L2.5 18.462a.755.755 0 01-1-.71V11.5L12 10 1.5 8.5V2.25z"/></svg>',
    attach: '<svg viewBox="0 0 20 20" width="18" height="18"><path fill="currentColor" d="M10.5 3a4.5 4.5 0 014.5 4.5v7a3 3 0 01-6 0v-6.5a1.5 1.5 0 013 0v5.5h-1.5V8a.5.5 0 00-1 0v6a1.5 1.5 0 003 0V7.5a3 3 0 00-6 0v7a4.5 4.5 0 009 0v-7A4.5 4.5 0 0010.5 3z"/></svg>',
    addReaction: '<svg viewBox="0 0 20 20" width="14" height="14"><path fill="currentColor" d="M10 2a8 8 0 110 16 8 8 0 010-16zm0 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM10 6a.75.75 0 01.75.75v2.5h2.5a.75.75 0 010 1.5h-2.5v2.5a.75.75 0 01-1.5 0v-2.5h-2.5a.75.75 0 010-1.5h2.5v-2.5A.75.75 0 0110 6z"/></svg>',
};

// ── Render Messages ──
function renderMessages() {
    const container = document.getElementById('messages-list');
    container.innerHTML = '';

    // Channel beginning header (like Slack's "This is the very beginning of #channel")
    if (state.currentChannel && state.messages.length > 0) {
        const ch = state.currentChannel;
        const loadMore = document.getElementById('load-more');
        // Only show if we're at the beginning (no more older messages to load)
        if (loadMore && loadMore.style.display === 'none') {
            const beginDiv = document.createElement('div');
            beginDiv.className = 'channel-beginning';
            if (ch.is_dm) {
                beginDiv.innerHTML = `
                    <div class="channel-beginning-icon" style="font-size:40px;margin-bottom:8px">💬</div>
                    <h3>${escapeHtml(ch.display_name || ch.name)}</h3>
                    <p>This is the very beginning of your direct message with <strong>${escapeHtml(ch.display_name || ch.name)}</strong>.</p>
                `;
            } else {
                beginDiv.innerHTML = `
                    <div class="channel-beginning-icon" style="font-size:40px;margin-bottom:8px">${ch.is_private ? '🔒' : '#'}</div>
                    <h3>${ch.is_private ? '🔒 ' : ''}${escapeHtml(ch.name)}</h3>
                    ${ch.purpose ? `<p>${escapeHtml(ch.purpose)}</p>` : ''}
                    <p style="color:#868686;font-size:13px">This is the very beginning of <strong>#${escapeHtml(ch.name)}</strong>.</p>
                `;
            }
            container.appendChild(beginDiv);
        }
    }

    let lastDate = null;
    let lastUser = null;
    let lastTs = null;

    state.messages.forEach((msg, idx) => {
        const ts = parseFloat(msg.ts);
        const date = new Date(ts * 1000);
        const dateStr = formatDate(date);

        // Date divider
        if (dateStr !== lastDate) {
            const divider = document.createElement('div');
            divider.className = 'date-divider';
            divider.innerHTML = `<span class="date-divider-text">${dateStr}</span>`;
            container.appendChild(divider);
            lastDate = dateStr;
            lastUser = null;
        }

        // System messages
        const systemSubtypes = [
            'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
            'channel_name', 'channel_archive', 'channel_unarchive',
            'pinned_item', 'unpinned_item', 'bot_add', 'bot_remove'
        ];

        if (systemSubtypes.includes(msg.subtype)) {
            const div = document.createElement('div');
            div.className = 'message system-message';
            div.dataset.ts = msg.ts;
            div.dataset.user = msg.user_id || '';
            div.innerHTML = `
                <div class="message-content">
                    <div class="message-text">${formatSystemMessage(msg)}</div>
                </div>
            `;
            container.appendChild(div);
            lastUser = null;
            return;
        }

        // Group consecutive messages from same user within 5 min
        const sameUser = msg.user_id === lastUser &&
            lastTs && (ts - lastTs) < 300;

        const div = document.createElement('div');
        div.className = `message${sameUser ? ' same-user' : ''}`;
        div.dataset.ts = msg.ts;
        div.dataset.user = msg.user_id || '';

        const editedBadge = msg.edited_ts ? '<span class="message-edited">(edited)</span>' : '';

        if (sameUser) {
            div.innerHTML = `
                <div class="message-avatar-placeholder"></div>
                <div class="message-content">
                    <div class="message-text">${formatMessageText(msg.text)}</div>
                    ${renderAttachments(msg)}
                    ${renderFiles(msg)}
                    ${renderReactions(msg)}
                    ${renderThreadIndicator(msg)}
                </div>
            `;
        } else {
            div.innerHTML = `
                <div class="message-avatar" title="${escapeHtml(msg.user_display_name || '')}" data-user-id="${msg.user_id || ''}">
                    ${msg.user_avatar
                        ? `<img src="${escapeHtml(msg.user_avatar)}" alt="">`
                        : `<div style="width:36px;height:36px;border-radius:6px;background:#${msg.user_color || '4a154b'};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:16px">${(msg.user_display_name || '?')[0].toUpperCase()}</div>`
                    }
                </div>
                <div class="message-content">
                    <div class="message-header">
                        <span class="message-sender" data-user-id="${msg.user_id || ''}">${escapeHtml(msg.user_display_name || msg.user_id || 'Unknown')}</span>
                        <span class="message-time" title="${date.toLocaleString()}">${formatTime(date)}</span>
                        ${editedBadge}
                    </div>
                    <div class="message-text">${formatMessageText(msg.text)}</div>
                    ${renderAttachments(msg)}
                    ${renderFiles(msg)}
                    ${renderReactions(msg)}
                    ${renderThreadIndicator(msg)}
                </div>
            `;
        }

        container.appendChild(div);
        lastUser = msg.user_id;
        lastTs = ts;
    });
}

// ── Format message text with Slack markup ──
function formatMessageText(text) {
    if (!text) return '';
    let html = escapeHtml(text);

    // Bold: *text*
    html = html.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
    // Italic: _text_
    html = html.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '<em>$1</em>');
    // Strikethrough: ~text~
    html = html.replace(/~([^~\n]+)~/g, '<del>$1</del>');
    // Inline code: `text`
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    // Code blocks: ```text```
    html = html.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');
    // Links: <url|label> or <url>
    html = html.replace(/&lt;(https?:\/\/[^|&]+)\|([^&]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$2</a>');
    html = html.replace(/&lt;(https?:\/\/[^&]+)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    // User mentions: <@U123>
    html = html.replace(/&lt;@(U[A-Z0-9]+)&gt;/g, (_, uid) => {
        const user = state.users[uid];
        const name = user ? (user.display_name || user.real_name || user.name) : uid;
        return `<span class="mention" data-user-id="${uid}">@${escapeHtml(name)}</span>`;
    });
    // Channel mentions: <#C123|name>
    html = html.replace(/&lt;#(C[A-Z0-9]+)\|([^&]+)&gt;/g, '<span class="channel-link">#$2</span>');
    html = html.replace(/&lt;#(C[A-Z0-9]+)&gt;/g, (_, cid) => {
        const ch = state.channels.find(c => c.id === cid);
        return `<span class="channel-link">#${ch ? escapeHtml(ch.name) : cid}</span>`;
    });
    // Blockquotes: > text
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    // Emoji shortcodes: :emoji:
    html = html.replace(/:([a-z0-9_+-]+):/g, (match, shortcode) => {
        if (typeof EMOJI_DATA !== 'undefined' && EMOJI_DATA[shortcode]) {
            return `<span class="emoji" title=":${shortcode}:">${EMOJI_DATA[shortcode]}</span>`;
        }
        return `<span class="emoji" title=":${shortcode}:">:${shortcode}:</span>`;
    });

    return html;
}

// ── Render attachments ──
function renderAttachments(msg) {
    const attachments = msg.attachments;
    if (!attachments || !Array.isArray(attachments) || attachments.length === 0) return '';

    return '<div class="message-attachments">' + attachments.map(att => {
        const borderColor = att.color ? `#${att.color}` : '#ddd';
        let html = `<div class="attachment" style="border-left-color: ${borderColor}">`;

        if (att.author_name) {
            html += `<div class="attachment-author">${escapeHtml(att.author_name)}</div>`;
        }
        if (att.title) {
            const titleHtml = att.title_link
                ? `<a href="${escapeHtml(att.title_link)}" target="_blank">${escapeHtml(att.title)}</a>`
                : escapeHtml(att.title);
            html += `<div class="attachment-title">${titleHtml}</div>`;
        }
        if (att.text) {
            html += `<div class="attachment-text">${escapeHtml(att.text)}</div>`;
        }
        if (att.image_url) {
            html += `<img class="attachment-image" src="${escapeHtml(att.image_url)}" alt="" onclick="openLightbox(this.src)">`;
        }
        if (att.thumb_url) {
            html += `<img class="attachment-image" src="${escapeHtml(att.thumb_url)}" alt="" style="max-width:75px;max-height:75px" onclick="openLightbox(this.src)">`;
        }
        if (att.footer) {
            html += `<div class="attachment-footer">${escapeHtml(att.footer)}</div>`;
        }

        html += '</div>';
        return html;
    }).join('') + '</div>';
}

// ── Render files ──
function getFileUrl(file) {
    // Use our proxy endpoint to avoid Slack CDN auth issues + cache locally
    if (file.id) return `/api/file/${file.id}`;
    return file.local_path || file.url_private || '';
}

function getThumbUrl(file) {
    // Only return thumb URL if the file actually has a thumbnail
    const hasThumb = file.thumb_360 || file.thumb_url || file.thumb_160;
    if (file.id && hasThumb) return `/api/file/${file.id}/thumb`;
    return '';
}

function getFileMimeType(file) {
    // Determine MIME type from file metadata
    if (file.mimetype) return file.mimetype;
    const ext = (file.name || '').split('.').pop().toLowerCase();
    const mimeMap = {
        'pdf': 'application/pdf', 'png': 'image/png', 'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg', 'gif': 'image/gif', 'webp': 'image/webp',
        'svg': 'image/svg+xml', 'mp4': 'video/mp4', 'webm': 'video/webm',
        'mov': 'video/quicktime', 'mp3': 'audio/mpeg', 'wav': 'audio/wav',
        'ogg': 'audio/ogg', 'm4a': 'audio/mp4',
    };
    return mimeMap[ext] || 'application/octet-stream';
}

function renderFiles(msg) {
    const files = msg.files;
    if (!files || !Array.isArray(files) || files.length === 0) return '';

    return '<div class="message-files">' + files.map(file => {
        const fileUrl = getFileUrl(file);
        const thumbUrl = getThumbUrl(file);
        const mime = getFileMimeType(file);
        const isImage = mime.startsWith('image/');
        const isVideo = mime.startsWith('video/');
        const isAudio = mime.startsWith('audio/');
        const isPdf = mime === 'application/pdf' || (file.filetype || '') === 'pdf';
        const sizeStr = formatFileSize(file.size || 0);
        const fname = escapeHtml(file.title || file.name || 'file');
        const ext = (file.name || '').split('.').pop().toUpperCase();

        if (isImage && fileUrl) {
            // Image: show inline preview, click to enlarge
            const imgSrc = thumbUrl || fileUrl;
            return `<div class="file-card file-card-image" onclick="openLightbox('${escapeHtml(fileUrl)}', '${fname}', '${escapeHtml(mime)}')">
                <img class="file-card-preview" src="${escapeHtml(imgSrc)}" alt="${fname}" loading="lazy"
                     onerror="this.style.display='none';this.parentElement.querySelector('.file-card-fallback').style.display='flex'">
                <div class="file-card-fallback" style="display:none;height:120px;align-items:center;justify-content:center;background:#f5f5f5">
                    <span style="font-size:36px">🖼️</span>
                </div>
                <div class="file-card-footer">
                    <span class="file-card-name">${fname}</span>
                    <span class="file-card-size">${sizeStr}</span>
                </div>
            </div>`;
        }

        if (isPdf && fileUrl) {
            return `<div class="file-card file-card-doc" onclick="openLightbox('${escapeHtml(fileUrl)}', '${fname}', 'application/pdf')">
                <div class="file-card-icon-area file-card-pdf">
                    <svg viewBox="0 0 24 24" width="32" height="32"><path fill="#E01E5A" d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 1.5L18.5 9H13V3.5zM6 20V4h5v7h7v9H6z"/></svg>
                    <span class="file-card-ext">PDF</span>
                </div>
                <div class="file-card-body">
                    <div class="file-card-name">${fname}</div>
                    <div class="file-card-meta">${sizeStr} · Click to preview</div>
                </div>
            </div>`;
        }

        if (isVideo && fileUrl) {
            return `<div class="file-card file-card-media">
                <video class="file-card-video" src="${escapeHtml(fileUrl)}" controls preload="metadata"
                       style="max-width:360px;max-height:240px;border-radius:6px;background:#000"></video>
                <div class="file-card-footer">
                    <span class="file-card-name">${fname}</span>
                    <span class="file-card-size">${sizeStr}</span>
                </div>
            </div>`;
        }

        if (isAudio && fileUrl) {
            return `<div class="file-card file-card-audio">
                <div class="file-card-icon-area file-card-audio-icon">
                    <span style="font-size:28px">🎵</span>
                </div>
                <div class="file-card-body" style="flex:1">
                    <div class="file-card-name">${fname}</div>
                    <audio src="${escapeHtml(fileUrl)}" controls preload="metadata" style="width:100%;margin-top:4px"></audio>
                </div>
            </div>`;
        }

        const icon = getFileIcon(file.filetype || file.mimetype || '');
        return `<div class="file-attachment" onclick="${fileUrl ? `openLightbox('${escapeHtml(fileUrl)}', '${fname}')` : ''}">
            <div class="file-info">
                <span class="file-icon">${icon}</span>
                <div class="file-details">
                    <div class="file-name">${escapeHtml(file.title || file.name || 'file')}</div>
                    <div class="file-meta">${escapeHtml(file.filetype || '')} \u2014 ${sizeStr}</div>
                </div>
            </div>
        </div>`;
    }).join('') + '</div>';
}

// ── Render reactions ──
function renderReactions(msg) {
    const reactions = msg.reactions;
    if (!reactions || !Array.isArray(reactions) || reactions.length === 0) return '';

    return '<div class="message-reactions">' + reactions.map(r => {
        const emojiChar = getEmojiUnicode(r.name || '');
        const isActive = r.users && r.users.includes(state.currentUserId);
        return `<button class="reaction${isActive ? ' active' : ''}" title=":${escapeHtml(r.name || '')}:" data-emoji="${escapeHtml(r.name || '')}" data-ts="${msg.ts}" onclick="toggleReaction(this)">
            <span class="reaction-emoji">${emojiChar}</span>
            <span class="reaction-count">${r.count || r.users?.length || 1}</span>
        </button>`;
    }).join('') +
    `<button class="reaction add-reaction-btn" title="Add reaction" data-ts="${msg.ts}" onclick="openReactionPicker(this)">
        ${ICONS.addReaction}
    </button>` +
    '</div>';
}

// ── Thread indicator ──
function renderThreadIndicator(msg) {
    if (!msg.reply_count || msg.reply_count === 0) return '';
    const replyUsers = msg.reply_users || [];

    return `<div class="thread-indicator" onclick="openThread('${msg.channel_id}', '${msg.ts}')">
        <div class="thread-avatars">
            ${replyUsers.slice(0, 3).map(uid => {
                const user = state.users[uid];
                const avatar = user?.avatar_local || user?.avatar_url;
                return avatar
                    ? `<img src="${escapeHtml(avatar)}" alt="">`
                    : '';
            }).join('')}
        </div>
        <span class="thread-count">${msg.reply_count} ${msg.reply_count === 1 ? 'reply' : 'replies'}</span>
    </div>`;
}

// ── System messages ──
function formatSystemMessage(msg) {
    const name = msg.user_display_name || msg.user_id || 'Someone';
    switch (msg.subtype) {
        case 'channel_join': return `<strong>${escapeHtml(name)}</strong> joined the channel`;
        case 'channel_leave': return `<strong>${escapeHtml(name)}</strong> left the channel`;
        case 'channel_topic': return `<strong>${escapeHtml(name)}</strong> set the channel topic: ${escapeHtml(msg.text || '')}`;
        case 'channel_purpose': return `<strong>${escapeHtml(name)}</strong> set the channel purpose: ${escapeHtml(msg.text || '')}`;
        case 'channel_name': return `<strong>${escapeHtml(name)}</strong> renamed the channel`;
        case 'pinned_item': return `<strong>${escapeHtml(name)}</strong> pinned a message`;
        default: return escapeHtml(msg.text || `[${msg.subtype}]`);
    }
}

// ── Thread panel ──
async function openThread(channelId, threadTs) {
    const panel = document.getElementById('thread-panel');
    const container = document.getElementById('thread-messages');
    panel.style.display = 'flex';
    container.innerHTML = '<div style="padding:20px;color:#999">Loading thread...</div>';

    // Set thread channel name
    const threadChName = document.getElementById('thread-channel-name');
    if (threadChName && state.currentChannel) {
        threadChName.textContent = state.currentChannel.is_dm
            ? (state.currentChannel.display_name || '')
            : '#' + state.currentChannel.name;
    }

    const msgs = await api(`/api/channels/${channelId}/threads/${threadTs}`);

    container.innerHTML = '';
    msgs.forEach(msg => {
        const ts = parseFloat(msg.ts);
        const date = new Date(ts * 1000);

        const div = document.createElement('div');
        div.className = 'message';
        div.dataset.ts = msg.ts;
        div.dataset.user = msg.user_id || '';
        div.innerHTML = `
            <div class="message-avatar" data-user-id="${msg.user_id || ''}">
                ${msg.user_avatar
                    ? `<img src="${escapeHtml(msg.user_avatar)}" alt="">`
                    : `<div style="width:36px;height:36px;border-radius:6px;background:#4a154b;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700">${(msg.user_display_name || '?')[0].toUpperCase()}</div>`
                }
            </div>
            <div class="message-content">
                <div class="message-header">
                    <span class="message-sender" data-user-id="${msg.user_id || ''}">${escapeHtml(msg.user_display_name || 'Unknown')}</span>
                    <span class="message-time">${formatTime(date)}</span>
                </div>
                <div class="message-text">${formatMessageText(msg.text)}</div>
                ${renderFiles(msg)}
                ${renderReactions(msg)}
            </div>
        `;
        container.appendChild(div);
    });
}

// ── Search ──
async function performSearch(query) {
    if (!query.trim()) {
        document.getElementById('search-overlay').style.display = 'none';
        return;
    }

    const results = await api(`/api/search?q=${encodeURIComponent(query)}`);
    const overlay = document.getElementById('search-overlay');
    const list = document.getElementById('search-results-list');

    overlay.style.display = 'flex';
    list.innerHTML = '';

    if (results.length === 0) {
        list.innerHTML = '<div style="padding:20px;text-align:center;color:#999">No results found.</div>';
        return;
    }

    // Show result count
    list.innerHTML = `<div style="padding:8px 16px;font-size:12px;color:#868686;border-bottom:1px solid #eee">${results.length} result${results.length !== 1 ? 's' : ''}</div>`;

    results.forEach(msg => {
        const ts = parseFloat(msg.ts);
        const date = new Date(ts * 1000);
        const avatar = msg.user_avatar || '';
        const name = msg.user_display_name || 'Unknown';
        const truncatedText = (msg.text || '').length > 200 ? (msg.text || '').substring(0, 200) + '...' : (msg.text || '');
        const div = document.createElement('div');
        div.className = 'search-result';
        div.innerHTML = `
            <div class="search-result-channel">#${escapeHtml(msg.channel_name || '')}</div>
            <div style="display:flex;gap:8px;align-items:flex-start">
                <div style="width:28px;height:28px;border-radius:4px;background:#e0e0e0;flex-shrink:0;overflow:hidden">
                    ${avatar ? `<img src="${escapeHtml(avatar)}" style="width:100%;height:100%;object-fit:cover">` : ''}
                </div>
                <div style="flex:1;min-width:0">
                    <div class="search-result-header">
                        <span class="search-result-sender">${escapeHtml(name)}</span>
                        <span class="search-result-time">${formatDate(date)}, ${formatTime(date)}</span>
                    </div>
                    <div class="search-result-text">${highlightSearch(escapeHtml(truncatedText), query)}</div>
                </div>
            </div>
        `;
        div.addEventListener('click', () => {
            const ch = state.channels.find(c => c.id === msg.channel_id);
            if (ch) {
                selectChannel(ch);
                overlay.style.display = 'none';
                document.getElementById('search-input').value = '';
            }
        });
        list.appendChild(div);
    });
}

function highlightSearch(text, query) {
    if (!query) return text;
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(regex, '<mark>$1</mark>');
}

// ── Stats ──
async function showStats() {
    const modal = document.getElementById('stats-modal');
    const body = document.getElementById('stats-body');
    modal.style.display = 'flex';
    body.innerHTML = '<p>Loading statistics...</p>';

    const stats = await api('/api/stats');
    body.innerHTML = `
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-number">${stats.total_messages?.toLocaleString() || 0}</div>
                <div class="stat-label">Messages</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${stats.total_channels?.toLocaleString() || 0}</div>
                <div class="stat-label">Channels</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${stats.total_users?.toLocaleString() || 0}</div>
                <div class="stat-label">Users</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${stats.total_files?.toLocaleString() || 0}</div>
                <div class="stat-label">Files</div>
            </div>
        </div>
        ${stats.oldest_message_date ? `<p style="font-size:13px;color:#616061;margin-bottom:12px">Oldest archived message: <strong>${stats.oldest_message_date}</strong></p>` : ''}

        <!-- Download All Media Section -->
        <div class="media-download-section" style="background:#f8f8f8;border-radius:8px;padding:14px 16px;margin-bottom:16px">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
                <div>
                    <div style="font-weight:700;font-size:14px;color:#1d1c1d">📥 Download All Media</div>
                    <div style="font-size:12px;color:#616061;margin-top:2px">${stats.total_files || 0} files — save everything locally for offline access</div>
                </div>
                <button class="btn-primary" id="btn-download-all-media" onclick="startMediaDownload()" style="white-space:nowrap;padding:6px 16px;font-size:13px">
                    Download All
                </button>
            </div>
            <div id="media-download-progress" style="display:none;margin-top:10px">
                <div class="upload-bar-track"><div class="upload-bar-fill" id="media-dl-bar" style="background:#007a5a"></div></div>
                <div style="display:flex;justify-content:space-between;margin-top:4px">
                    <span style="font-size:12px;color:#616061" id="media-dl-text">Starting...</span>
                    <span style="font-size:12px;color:#616061" id="media-dl-count"></span>
                </div>
            </div>
        </div>

        <h4 style="margin:8px 0">Channels by message count</h4>
        <table class="stats-table">
            <thead><tr><th>Channel</th><th>Messages</th><th>Oldest</th><th>Newest</th></tr></thead>
            <tbody>
                ${(stats.channels || []).filter(c => c.message_count > 0).map(ch => {
                    const oldest = ch.oldest_message ? new Date(parseFloat(ch.oldest_message) * 1000).toLocaleDateString() : '-';
                    const newest = ch.newest_message ? new Date(parseFloat(ch.newest_message) * 1000).toLocaleDateString() : '-';
                    return `<tr>
                        <td>${ch.is_dm ? '\u{1F4AC}' : '#'} ${escapeHtml(ch.name || '')}</td>
                        <td>${ch.message_count?.toLocaleString()}</td>
                        <td>${oldest}</td>
                        <td>${newest}</td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>
    `;
}

// ══════════════════════════════════════════
// ── Media Download (batch) ──
// ══════════════════════════════════════════
let mediaDownloadPoll = null;

async function startMediaDownload() {
    const btn = document.getElementById('btn-download-all-media');
    const progress = document.getElementById('media-download-progress');

    if (btn) { btn.disabled = true; btn.textContent = 'Downloading...'; }
    if (progress) progress.style.display = 'block';

    const resp = await fetch('/api/files/download-all', { method: 'POST' });
    const data = await resp.json();

    if (data.error) {
        if (btn) { btn.disabled = false; btn.textContent = 'Download All'; }
        showUploadToast(data.error, false);
        return;
    }

    // Poll for status
    if (mediaDownloadPoll) clearInterval(mediaDownloadPoll);
    mediaDownloadPoll = setInterval(async () => {
        const status = await api('/api/files/download-status');
        updateMediaDownloadUI(status);
        if (!status.running) {
            clearInterval(mediaDownloadPoll);
            mediaDownloadPoll = null;
            if (btn) { btn.disabled = false; btn.textContent = 'Download All'; }
            if (status.downloaded > 0) {
                showUploadToast(`${status.downloaded} files downloaded locally`, true);
            }
        }
    }, 1000);
}

function updateMediaDownloadUI(status) {
    const bar = document.getElementById('media-dl-bar');
    const text = document.getElementById('media-dl-text');
    const count = document.getElementById('media-dl-count');
    const progress = document.getElementById('media-download-progress');

    if (progress) progress.style.display = 'block';

    const pct = status.total > 0 ? Math.round((status.downloaded / status.total) * 100) : 0;
    if (bar) bar.style.width = pct + '%';
    if (text) {
        if (status.running) {
            text.textContent = `Downloading: ${escapeHtml(status.current_file || '...')}`;
        } else {
            const failText = status.failed > 0 ? ` (${status.failed} failed)` : '';
            text.innerHTML = `<span style="color:#007a5a;font-weight:700">✓ Complete</span>${failText}`;
        }
    }
    if (count) count.textContent = `${status.downloaded}/${status.total}`;
}

// Auto-download media after sync completes
function autoDownloadMediaAfterSync() {
    // Check if there are uncached files and auto-start download
    setTimeout(async () => {
        try {
            const status = await api('/api/files/download-status');
            if (!status.running) {
                startMediaDownload();
            }
        } catch (e) { /* ignore */ }
    }, 3000);
}

// ── Sync ──
async function startSync() {
    startSelectedSync('modal');
}

// ══════════════════════════════════════════
// ── Live Messaging + Notifications ──
// ══════════════════════════════════════════
let livePollInterval = null;
let latestTs = null;
let notificationsEnabled = false;
let notificationSound = null;

// Request notification permission on first interaction
function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().then(perm => {
            notificationsEnabled = (perm === 'granted');
        });
    } else if ('Notification' in window && Notification.permission === 'granted') {
        notificationsEnabled = true;
    }
}

function showDesktopNotification(msg) {
    if (!notificationsEnabled || !('Notification' in window)) return;
    // Don't notify for own messages
    if (msg.user_id === state.currentUserId) return;
    // Don't notify if page is focused and user is viewing this channel
    if (document.hasFocus() && state.currentChannel && state.currentChannel.id === msg.channel_id) return;

    const sender = msg.user_display_name || msg.user_id || 'Someone';
    const channelName = state.currentChannel ? (state.currentChannel.display_name || state.currentChannel.name) : '';
    const text = (msg.text || '').substring(0, 120);
    const title = channelName ? `${sender} in #${channelName}` : sender;

    try {
        const notif = new Notification(title, {
            body: text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
            icon: msg.user_avatar || '/static/avatars/default.png',
            tag: `slack-${msg.ts}`,
            silent: false,
        });

        // Click notification → focus window and jump to channel
        notif.onclick = () => {
            window.focus();
            if (state.currentChannel && msg.channel_id === state.currentChannel.id) {
                // Already on this channel, scroll to bottom
                const scroll = document.getElementById('messages-scroll');
                if (scroll) scroll.scrollTop = scroll.scrollHeight;
            }
            notif.close();
        };

        // Auto-close after 5 seconds
        setTimeout(() => notif.close(), 5000);
    } catch (e) { /* ignore */ }
}

function showInAppNotification(msg) {
    // Show a toast notification inside the app
    const sender = msg.user_display_name || 'Someone';
    const text = (msg.text || '').substring(0, 80).replace(/<[^>]+>/g, '');
    const avatar = msg.user_avatar || '';

    // Create toast container if not exists
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = 'position:fixed;top:52px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;max-width:360px;';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'notification-toast';
    toast.innerHTML = `
        <div style="display:flex;gap:10px;align-items:flex-start">
            ${avatar ? `<img src="${escapeHtml(avatar)}" style="width:32px;height:32px;border-radius:4px;flex-shrink:0" alt="">` : ''}
            <div style="min-width:0">
                <div style="font-weight:700;font-size:13px;color:#1d1c1d">${escapeHtml(sender)}</div>
                <div style="font-size:13px;color:#616061;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(text)}</div>
            </div>
            <button onclick="this.closest('.notification-toast').remove()" style="background:none;border:none;font-size:16px;color:#999;cursor:pointer;padding:0;line-height:1;flex-shrink:0">&times;</button>
        </div>
    `;
    container.appendChild(toast);

    // Play a subtle sound
    playNotificationSound();

    // Animate in
    toast.style.animation = 'toastSlideIn 0.3s ease-out';

    // Auto-remove after 4 seconds
    setTimeout(() => {
        toast.style.animation = 'toastSlideOut 0.3s ease-in';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function playNotificationSound() {
    try {
        // Slack-style "knock knock" two-tone notification
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const t = ctx.currentTime;

        // First knock — higher pitch
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(932, t);        // Bb5
        gain1.gain.setValueAtTime(0.15, t);
        gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        osc1.start(t);
        osc1.stop(t + 0.08);

        // Second knock — slightly lower, after short gap
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(784, t + 0.12);  // G5
        gain2.gain.setValueAtTime(0, t);
        gain2.gain.setValueAtTime(0.12, t + 0.12);
        gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
        osc2.start(t + 0.12);
        osc2.stop(t + 0.22);

        // Third subtle tap — softer, completes the pattern
        const osc3 = ctx.createOscillator();
        const gain3 = ctx.createGain();
        osc3.connect(gain3);
        gain3.connect(ctx.destination);
        osc3.type = 'sine';
        osc3.frequency.setValueAtTime(1047, t + 0.28); // C6
        gain3.gain.setValueAtTime(0, t);
        gain3.gain.setValueAtTime(0.08, t + 0.28);
        gain3.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
        osc3.start(t + 0.28);
        osc3.stop(t + 0.38);

        // Clean up
        setTimeout(() => ctx.close(), 500);
    } catch (e) { /* ignore */ }
}

function startLivePolling(channelId) {
    if (livePollInterval) clearInterval(livePollInterval);

    // Request notification permission
    requestNotificationPermission();

    if (state.messages.length > 0) {
        latestTs = state.messages[state.messages.length - 1].ts;
    } else {
        latestTs = String(Date.now() / 1000);
    }

    livePollInterval = setInterval(async () => {
        if (!state.currentChannel || state.currentChannel.id !== channelId) {
            clearInterval(livePollInterval);
            return;
        }
        try {
            const newMsgs = await api(`/api/channels/${channelId}/poll?since=${latestTs}`);
            if (newMsgs.length > 0) {
                let hasNewFromOthers = false;
                for (const msg of newMsgs) {
                    if (!state.messages.find(m => m.ts === msg.ts)) {
                        state.messages.push(msg);

                        // Notify for messages from others
                        if (msg.user_id !== state.currentUserId) {
                            hasNewFromOthers = true;
                            showDesktopNotification(msg);
                            showInAppNotification(msg);
                        }
                    }
                }
                latestTs = state.messages[state.messages.length - 1].ts;

                renderMessages();
                const scroll = document.getElementById('messages-scroll');
                scroll.scrollTop = scroll.scrollHeight;

                // Update page title with unread indicator
                if (hasNewFromOthers && !document.hasFocus()) {
                    document.title = '• New messages — ' + (state.currentChannel?.name || 'Slack Archive');
                }
            }
        } catch (e) { /* ignore */ }
    }, 3000);
}

// Reset title when window gets focus
window.addEventListener('focus', () => {
    const ws = document.getElementById('workspace-name');
    document.title = (ws ? ws.textContent : 'Slack') + ' Archive';
});

function handleMessageKeydown(e) {
    const textarea = e.target;

    // Auto-grow textarea
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';

    // Handle mention autocomplete navigation
    const mentionDropdown = document.getElementById('mention-autocomplete');
    if (mentionDropdown && mentionDropdown.style.display !== 'none') {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            navigateMentionAutocomplete(1);
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            navigateMentionAutocomplete(-1);
            return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            const selected = mentionDropdown.querySelector('.mention-item.selected');
            if (selected) {
                e.preventDefault();
                selectMentionItem(selected);
                return;
            }
        }
        if (e.key === 'Escape') {
            hideMentionAutocomplete();
            return;
        }
    }

    // Handle emoji autocomplete navigation
    const emojiDropdown = document.getElementById('emoji-autocomplete');
    if (emojiDropdown && emojiDropdown.style.display !== 'none') {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            navigateEmojiAutocomplete(1);
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            navigateEmojiAutocomplete(-1);
            return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            const selected = emojiDropdown.querySelector('.emoji-ac-item.selected');
            if (selected) {
                e.preventDefault();
                selectEmojiAutocompleteItem(selected);
                return;
            }
        }
        if (e.key === 'Escape') {
            hideEmojiAutocomplete();
            return;
        }
    }

    // Enter sends, Shift+Enter adds newline
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
        return;
    }

    // Up arrow in empty composer: edit last sent message
    if (e.key === 'ArrowUp' && textarea.value === '' && state.currentUserId) {
        e.preventDefault();
        const lastOwnMsg = [...state.messages].reverse().find(m => m.user_id === state.currentUserId);
        if (lastOwnMsg) {
            startEditMessage(lastOwnMsg.ts);
        }
        return;
    }

    // Check for autocomplete triggers
    setTimeout(() => checkComposerAutocomplete(textarea), 0);
}

function checkComposerAutocomplete(textarea) {
    const val = textarea.value;
    const pos = textarea.selectionStart;
    const textBefore = val.substring(0, pos);

    // Check for @mention — after space, newline, or at start of text
    const mentionMatch = textBefore.match(/(?:^|[\s])@(\w*)$/);
    if (mentionMatch) {
        showMentionAutocomplete(mentionMatch[1]);
        return;
    } else {
        hideMentionAutocomplete();
    }

    // Check for :emoji — after space, newline, or at start
    const emojiMatch = textBefore.match(/(?:^|[\s]):([a-z0-9_+-]{2,})$/);
    if (emojiMatch) {
        showEmojiAutocomplete(emojiMatch[1]);
        return;
    } else {
        hideEmojiAutocomplete();
    }
}

function convertMentionsForSend(text) {
    // Convert @DisplayName back to <@USER_ID> for Slack API
    let result = text;
    if (state.mentionMap) {
        // Sort by length descending to avoid partial replacements
        const keys = Object.keys(state.mentionMap).sort((a, b) => b.length - a.length);
        for (const display of keys) {
            result = result.split(display).join(state.mentionMap[display]);
        }
    }
    return result;
}

async function sendMessage() {
    const input = document.getElementById('message-input');
    const rawText = input.value.trim();
    if (!rawText || !state.currentChannel) return;
    const text = convertMentionsForSend(rawText);

    const btn = document.getElementById('btn-send');
    btn.disabled = true;
    input.disabled = true;

    try {
        const resp = await fetch(`/api/channels/${state.currentChannel.id}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        const data = await resp.json();

        if (data.error) {
            alert('Failed to send: ' + data.error);
        } else {
            input.value = '';
            input.style.height = 'auto';
            state.mentionMap = {}; // Clear mention mappings

            if (state.currentChannel) {
                const newMsgs = await api(`/api/channels/${state.currentChannel.id}/poll?since=${latestTs}`);
                if (newMsgs.length > 0) {
                    for (const msg of newMsgs) {
                        if (!state.messages.find(m => m.ts === msg.ts)) {
                            state.messages.push(msg);
                        }
                    }
                    latestTs = state.messages[state.messages.length - 1].ts;
                    renderMessages();
                    const scroll = document.getElementById('messages-scroll');
                    scroll.scrollTop = scroll.scrollHeight;
                }
            }
        }
    } catch (e) {
        alert('Send error: ' + e.message);
    }

    btn.disabled = false;
    input.disabled = false;
    input.focus();
}

// ── Load users for mention resolution ──
async function loadUsers() {
    const users = await api('/api/users');
    state.users = {};
    users.forEach(u => { state.users[u.id] = u; });
}

// ══════════════════════════════════════════
// ── Token Health Check ──
// ══════════════════════════════════════════
let tokenHealthInterval = null;
let tokenExpiredShown = false;

async function checkTokenHealth() {
    try {
        const data = await api('/api/token-health');
        if (data.valid) {
            // Token is good — hide any warning
            hideTokenWarning();
            tokenExpiredShown = false;
        } else {
            // Token is expired/revoked
            showTokenWarning(data.message || 'Your Slack token has expired');
        }
    } catch (e) {
        // Network error — don't show warning (could be temporary)
    }
}

function showTokenWarning(message) {
    if (tokenExpiredShown) return;
    tokenExpiredShown = true;

    // Remove existing warning if any
    hideTokenWarning();

    const banner = document.createElement('div');
    banner.id = 'token-warning-banner';
    banner.style.cssText = `
        position: fixed; top: 44px; left: 0; right: 0; z-index: 999;
        background: #FFF3CD; border-bottom: 1px solid #FFE082;
        padding: 10px 20px; display: flex; align-items: center;
        justify-content: space-between; gap: 12px;
        font-size: 14px; color: #856404;
        animation: slideDown 0.3s ease-out;
    `;
    banner.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px">
            <svg viewBox="0 0 20 20" width="18" height="18" style="flex-shrink:0"><path fill="#856404" d="M10 2a8 8 0 110 16 8 8 0 010-16zm0 3a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1zm0 8a1 1 0 100 2 1 1 0 000-2z"/></svg>
            <span><strong>Token expired.</strong> ${escapeHtml(message)}. Live features (send, sync, presence) won't work until you reconnect.</span>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
            <button onclick="showSetupWizardForNewWorkspace()" style="background:#007A5A;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:700">Reconnect</button>
            <button onclick="hideTokenWarning()" style="background:none;border:1px solid #856404;color:#856404;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:13px">Dismiss</button>
        </div>
    `;

    // Add animation keyframes
    if (!document.getElementById('token-warning-style')) {
        const style = document.createElement('style');
        style.id = 'token-warning-style';
        style.textContent = '@keyframes slideDown { from { transform: translateY(-100%); } to { transform: translateY(0); } }';
        document.head.appendChild(style);
    }

    document.body.appendChild(banner);

    // Also play notification sound
    playNotificationSound();
}

function hideTokenWarning() {
    const banner = document.getElementById('token-warning-banner');
    if (banner) banner.remove();
}

function startTokenHealthCheck() {
    // Check immediately on load
    setTimeout(() => checkTokenHealth(), 5000);

    // Then check every 5 minutes
    if (!tokenHealthInterval) {
        tokenHealthInterval = setInterval(() => checkTokenHealth(), 5 * 60 * 1000);
    }
}

// Start health check when app loads (called from enterApp or checkSetupStatus)
// We'll hook into the existing enterApp function

// ══════════════════════════════════════════
// ── Online/Offline Presence ──
// ══════════════════════════════════════════
let presenceCache = {}; // userId → {online: bool, ts: timestamp}
let presenceInterval = null;

async function loadPresenceForDMs() {
    // Get all unique DM user IDs from sidebar
    const dots = document.querySelectorAll('.presence-dot[data-user]');
    const userIds = [...new Set([...dots].map(d => d.dataset.user).filter(Boolean))];

    // Fetch presence for each (limit to first 20 to avoid rate limits)
    const batch = userIds.slice(0, 20);
    for (const uid of batch) {
        try {
            const data = await api(`/api/users/${uid}/presence`);
            if (data && !data.error) {
                presenceCache[uid] = { online: data.online, ts: Date.now() };
                updatePresenceDot(uid, data.online);
            }
        } catch (e) { /* ignore */ }
    }

    // Refresh every 60 seconds
    if (!presenceInterval) {
        presenceInterval = setInterval(() => loadPresenceForDMs(), 60000);
    }
}

function updatePresenceDot(userId, online) {
    // Update all presence dots for this user
    document.querySelectorAll(`.presence-dot[data-user="${userId}"]`).forEach(dot => {
        dot.style.display = '';
        dot.classList.toggle('online', online);
        dot.classList.toggle('offline', !online);
    });

    // Also update chat header if viewing this user's DM
    if (state.currentChannel && state.currentChannel.is_dm && state.currentChannel.name === userId) {
        updateChatHeaderPresence(online);
    }
}

function updateChatHeaderPresence(online) {
    const memberCount = document.getElementById('member-count');
    if (memberCount) {
        memberCount.innerHTML = online
            ? '<span class="header-presence online-text">Active</span>'
            : '<span class="header-presence offline-text">Away</span>';
    }
}

// ── Lightbox ──
function openLightbox(src, filename, mimeType) {
    const lb = document.getElementById('lightbox');
    const img = document.getElementById('lightbox-img');
    const pdf = document.getElementById('lightbox-pdf');
    const video = document.getElementById('lightbox-video');
    const audio = document.getElementById('lightbox-audio');
    const fnEl = document.getElementById('lightbox-filename');
    const dlEl = document.getElementById('lightbox-download');

    // Hide all content types
    if (img) img.style.display = 'none';
    if (pdf) pdf.style.display = 'none';
    if (video) { video.style.display = 'none'; video.pause(); video.src = ''; }
    if (audio) { audio.style.display = 'none'; audio.pause(); audio.src = ''; }

    const name = filename || src.split('/').pop().split('?')[0] || 'file';
    if (fnEl) fnEl.textContent = name;
    if (dlEl) { dlEl.href = src; dlEl.download = name; }

    // Determine type from explicit MIME, then fall back to extension
    const mime = (mimeType || '').toLowerCase();
    const ext = (name.split('.').pop() || '').toLowerCase();

    if (mime === 'application/pdf' || ext === 'pdf') {
        if (pdf) { pdf.src = src; pdf.style.display = 'block'; }
    } else if (mime.startsWith('video/') || ['mp4','webm','mov','avi'].includes(ext)) {
        if (video) { video.src = src; video.style.display = 'block'; }
    } else if (mime.startsWith('audio/') || ['mp3','wav','ogg','aac','m4a','flac'].includes(ext)) {
        if (audio) { audio.src = src; audio.style.display = 'block'; }
    } else {
        // Default to image
        if (img) { img.src = src; img.style.display = 'block'; }
    }

    lb.style.display = 'flex';
}

function closeLightbox() {
    const lb = document.getElementById('lightbox');
    if (!lb) return;
    lb.style.display = 'none';
    // Stop any playing media
    const video = document.getElementById('lightbox-video');
    const audio = document.getElementById('lightbox-audio');
    if (video) { video.pause(); video.src = ''; }
    if (audio) { audio.pause(); audio.src = ''; }
    const pdf = document.getElementById('lightbox-pdf');
    if (pdf) pdf.src = '';
}

// ── Toast notifications (Slack-style) ──
function showToast(message, duration = 3000) {
    let toast = document.getElementById('toast-notification');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast-notification';
        toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1D1C1D;color:#fff;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.2);opacity:0;transition:opacity 0.2s;pointer-events:none';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, duration);
}

// ══════════════════════════════════════════
// ── Message Hover Action Bar ──
// ══════════════════════════════════════════
function showMessageActions(msgEl) {
    hideMessageActions();

    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    bar.innerHTML = `
        <button class="msg-action-btn" data-action="react" title="Add reaction">${ICONS.reaction}</button>
        <button class="msg-action-btn" data-action="thread" title="Reply in thread">${ICONS.thread}</button>
        <button class="msg-action-btn" data-action="bookmark" title="Bookmark">${ICONS.bookmark}</button>
        <button class="msg-action-btn" data-action="more" title="More actions">${ICONS.more}</button>
    `;

    bar.addEventListener('click', (e) => {
        const btn = e.target.closest('.msg-action-btn');
        if (!btn) return;
        e.stopPropagation();
        const action = btn.dataset.action;
        const ts = msgEl.dataset.ts;
        const userId = msgEl.dataset.user;

        if (action === 'react') {
            openReactionPickerForMessage(ts, btn);
        } else if (action === 'thread') {
            if (state.currentChannel) openThread(state.currentChannel.id, ts);
        } else if (action === 'more') {
            showContextMenuForMessage(ts, userId, btn);
        }
    });

    msgEl.appendChild(bar);
    msgEl.classList.add('hover-active');
}

function hideMessageActions() {
    document.querySelectorAll('.msg-actions').forEach(el => el.remove());
    document.querySelectorAll('.message.hover-active').forEach(el => el.classList.remove('hover-active'));
}

// ══════════════════════════════════════════
// ── Emoji Picker ──
// ══════════════════════════════════════════
function showEmojiPicker(targetEl, callback) {
    hideEmojiPicker();
    state.emojiPickerCallback = callback;
    state.emojiPickerTarget = targetEl;

    const picker = document.getElementById('emoji-picker');
    if (!picker) return;

    const categories = getEmojiCategories();
    const catNames = Object.keys(categories);

    // Populate the picker
    const searchInput = document.getElementById('emoji-search');
    const catContainer = document.getElementById('emoji-categories');
    const grid = document.getElementById('emoji-grid');
    const preview = document.getElementById('emoji-preview');

    if (searchInput) searchInput.value = '';

    if (catContainer) {
        catContainer.innerHTML = catNames.map((name, i) => `<button class="emoji-cat-btn${i === 0 ? ' active' : ''}" data-cat="${i}" title="${name}">${getCategoryIcon(name)}</button>`).join('');
        catContainer.querySelectorAll('.emoji-cat-btn').forEach(btn => {
            btn.onclick = () => {
                catContainer.querySelectorAll('.emoji-cat-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                renderEmojiGridCategory(parseInt(btn.dataset.cat), categories, catNames);
            };
        });
    }

    // Render first category
    renderEmojiGridCategory(0, categories, catNames);

    // Position the picker
    const rect = targetEl.getBoundingClientRect();
    let top = rect.top - 360;
    let left = rect.left;
    if (top < 10) top = rect.bottom + 8;
    if (left + 320 > window.innerWidth) left = window.innerWidth - 330;
    if (left < 10) left = 10;
    picker.style.top = top + 'px';
    picker.style.left = left + 'px';
    picker.style.display = 'block';
    picker.style.position = 'fixed';

    if (searchInput) {
        searchInput.focus();
        searchInput.oninput = () => {
            const q = searchInput.value.toLowerCase().trim();
            if (!q) {
                const activeBtn = catContainer?.querySelector('.emoji-cat-btn.active');
                renderEmojiGridCategory(parseInt(activeBtn?.dataset.cat || '0'), categories, catNames);
            } else {
                renderEmojiSearchResults(q);
            }
        };
    }

    setTimeout(() => {
        document.addEventListener('click', emojiPickerOutsideClick);
    }, 100);
}

function emojiPickerOutsideClick(e) {
    const picker = document.getElementById('emoji-picker');
    if (picker && !picker.contains(e.target)) {
        hideEmojiPicker();
    }
}

function hideEmojiPicker() {
    const picker = document.getElementById('emoji-picker');
    if (picker) picker.style.display = 'none';
    state.emojiPickerCallback = null;
    state.emojiPickerTarget = null;
    document.removeEventListener('click', emojiPickerOutsideClick);
}

function renderEmojiGridCategory(catIndex, categories, catNames) {
    const grid = document.getElementById('emoji-grid');
    if (!grid) return;
    const name = catNames[catIndex];
    const emojis = categories[name] || [];

    if (emojis.length === 0) {
        grid.innerHTML = '<div style="padding:20px;text-align:center;color:#999;font-size:13px">No emojis</div>';
        return;
    }

    grid.innerHTML = emojis.map(shortcode => {
        const char = getEmojiUnicode(shortcode);
        return `<button class="emoji-grid-item" data-shortcode="${shortcode}" title=":${shortcode}:">${char}</button>`;
    }).join('');

    attachEmojiGridHandlers(grid);
}

function renderEmojiSearchResults(query) {
    const grid = document.getElementById('emoji-grid');
    if (!grid || typeof EMOJI_DATA === 'undefined') return;

    const results = Object.keys(EMOJI_DATA).filter(k => k.includes(query)).slice(0, 60);
    if (results.length === 0) {
        grid.innerHTML = '<div style="padding:20px;text-align:center;color:#999;font-size:13px">No matches</div>';
        return;
    }

    grid.innerHTML = results.map(shortcode => {
        return `<button class="emoji-grid-item" data-shortcode="${shortcode}" title=":${shortcode}:">${EMOJI_DATA[shortcode]}</button>`;
    }).join('');

    attachEmojiGridHandlers(grid);
}

function attachEmojiGridHandlers(grid) {
    grid.querySelectorAll('.emoji-grid-item').forEach(btn => {
        btn.addEventListener('click', () => {
            const sc = btn.dataset.shortcode;
            trackFrequentEmoji(sc);
            if (state.emojiPickerCallback) {
                state.emojiPickerCallback(sc);
            }
            hideEmojiPicker();
        });
        btn.addEventListener('mouseenter', () => {
            const previewEl = document.getElementById('emoji-preview');
            if (previewEl) {
                const nameEl = previewEl.querySelector('.emoji-preview-name');
                const charEl = previewEl.querySelector('.emoji-preview-char');
                if (nameEl) nameEl.textContent = `:${btn.dataset.shortcode}:`;
                if (charEl) charEl.textContent = getEmojiUnicode(btn.dataset.shortcode);
            }
        });
    });
}

function getCategoryIcon(name) {
    const icons = {
        'Frequently Used': '\u{1F553}',
        'Smileys & People': '\u{1F600}',
        'Animals & Nature': '\u{1F43B}',
        'Food & Drink': '\u{1F354}',
        'Activity': '\u26BD',
        'Travel & Places': '\u{1F3E0}',
        'Objects': '\u{1F4A1}',
        'Symbols': '\u2764\uFE0F',
        'Flags': '\u{1F3F3}\uFE0F'
    };
    return icons[name] || '\u{1F600}';
}

// ══════════════════════════════════════════
// ── Add/Remove Reactions ──
// ══════════════════════════════════════════
function openReactionPickerForMessage(ts, triggerEl) {
    showEmojiPicker(triggerEl, async (shortcode) => {
        if (!state.currentChannel) return;
        try {
            await fetch(`/api/channels/${state.currentChannel.id}/react`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: shortcode, ts: ts, action: 'add' })
            });
            await loadMessages(state.currentChannel.id, false);
        } catch (e) {
            console.error('Failed to add reaction:', e);
        }
    });
}

function openReactionPicker(btn) {
    const ts = btn.dataset.ts;
    openReactionPickerForMessage(ts, btn);
}

async function toggleReaction(btn) {
    if (!state.currentChannel) return;
    const emoji = btn.dataset.emoji;
    const ts = btn.dataset.ts;
    const isActive = btn.classList.contains('active');
    const action = isActive ? 'remove' : 'add';

    try {
        await fetch(`/api/channels/${state.currentChannel.id}/react`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: emoji, ts: ts, action: action })
        });
        await loadMessages(state.currentChannel.id, false);
    } catch (e) {
        console.error('Failed to toggle reaction:', e);
    }
}

// ══════════════════════════════════════════
// ── Message Edit ──
// ══════════════════════════════════════════
function startEditMessage(ts) {
    const msg = state.messages.find(m => m.ts === ts);
    if (!msg || msg.user_id !== state.currentUserId) return;

    state.editingMessageTs = ts;
    const msgEl = document.querySelector(`.message[data-ts="${ts}"]`);
    if (!msgEl) return;

    const textEl = msgEl.querySelector('.message-text');
    if (!textEl) return;

    const originalText = msg.text || '';

    // Add editing highlight to the message
    msgEl.classList.add('editing');

    textEl.innerHTML = `
        <div class="edit-message-container">
            <textarea class="edit-message-input">${escapeHtml(originalText)}</textarea>
            <div class="edit-message-actions">
                <span style="font-size:11px;color:#868686;margin-right:auto">escape to <a href="#" onclick="cancelEditMessage('${ts}');return false" style="color:#1264A3">cancel</a> · enter to <a href="#" onclick="saveEditMessage('${ts}');return false" style="color:#1264A3">save</a></span>
                <button class="btn-edit-cancel" onclick="cancelEditMessage('${ts}')">Cancel</button>
                <button class="btn-edit-save" onclick="saveEditMessage('${ts}')">Save Changes</button>
            </div>
        </div>
    `;

    const textarea = textEl.querySelector('.edit-message-input');
    // Auto-resize to fit content
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
        // Enable @mention and :emoji autocomplete in edit mode
        checkComposerAutocomplete(textarea);
    });
    textarea.addEventListener('focus', () => {
        state.activeTextarea = textarea;
    });
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideMentionAutocomplete();
            hideEmojiAutocomplete();
            cancelEditMessage(ts);
            return;
        }
        // Handle mention/emoji autocomplete navigation in edit mode
        const mentionDropdown = document.getElementById('mention-autocomplete');
        if (mentionDropdown && mentionDropdown.style.display !== 'none') {
            if (e.key === 'ArrowDown') { e.preventDefault(); navigateMentionAutocomplete(1); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); navigateMentionAutocomplete(-1); return; }
            if (e.key === 'Enter') {
                e.preventDefault();
                const selected = mentionDropdown.querySelector('.mention-item.selected');
                if (selected) selectMentionItem(selected);
                return;
            }
            if (e.key === 'Tab') { e.preventDefault(); const sel = mentionDropdown.querySelector('.mention-item.selected'); if (sel) selectMentionItem(sel); return; }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            saveEditMessage(ts);
        }
    });
    // Track as active textarea for autocomplete
    state.activeTextarea = textarea;
}

function cancelEditMessage(ts) {
    state.editingMessageTs = null;
    // Remove editing highlight
    const msgEl = document.querySelector(`.message[data-ts="${ts}"]`);
    if (msgEl) msgEl.classList.remove('editing');
    renderMessages();
}

async function saveEditMessage(ts) {
    if (!state.currentChannel) return;
    const msgEl = document.querySelector(`.message[data-ts="${ts}"]`);
    if (!msgEl) return;
    const textarea = msgEl.querySelector('.edit-message-input');
    if (!textarea) return;

    const newText = textarea.value.trim();
    if (!newText) return;

    try {
        const resp = await fetch(`/api/messages/${state.currentChannel.id}/${ts}/edit`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: newText })
        });
        const data = await resp.json();
        if (data.error) {
            alert('Edit failed: ' + data.error);
            return;
        }
        const msg = state.messages.find(m => m.ts === ts);
        if (msg) {
            msg.text = newText;
            msg.edited_ts = String(Date.now() / 1000);
        }
    } catch (e) {
        alert('Edit error: ' + e.message);
    }

    state.editingMessageTs = null;
    renderMessages();
}

// ══════════════════════════════════════════
// ── Message Delete ──
// ══════════════════════════════════════════
async function deleteMessage(ts) {
    if (!state.currentChannel) return;

    // Use confirm modal if it exists, otherwise native confirm
    const confirmModal = document.getElementById('confirm-modal');
    if (confirmModal) {
        document.getElementById('confirm-title').textContent = 'Delete message';
        document.getElementById('confirm-message').textContent = 'Are you sure you want to delete this message? This cannot be undone.';
        confirmModal.style.display = 'flex';

        return new Promise((resolve) => {
            const okBtn = document.getElementById('confirm-ok');
            const cancelBtn = document.getElementById('confirm-cancel');
            const onOk = async () => {
                confirmModal.style.display = 'none';
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                await performDeleteMessage(ts);
                resolve();
            };
            const onCancel = () => {
                confirmModal.style.display = 'none';
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                resolve();
            };
            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
        });
    } else {
        if (!confirm('Are you sure you want to delete this message?')) return;
        await performDeleteMessage(ts);
    }
}

async function performDeleteMessage(ts) {
    try {
        const resp = await fetch(`/api/messages/${state.currentChannel.id}/${ts}`, {
            method: 'DELETE'
        });
        const data = await resp.json();
        if (data.error) {
            alert('Delete failed: ' + data.error);
            return;
        }
        state.messages = state.messages.filter(m => m.ts !== ts);
        const msgEl = document.querySelector(`.message[data-ts="${ts}"]`);
        if (msgEl) msgEl.remove();
    } catch (e) {
        alert('Delete error: ' + e.message);
    }
}

// ══════════════════════════════════════════
// ── Context Menu ──
// ══════════════════════════════════════════
function showContextMenu(x, y, ts, userId) {
    hideContextMenu();
    const isOwn = userId === state.currentUserId;

    const menu = document.getElementById('context-menu');
    if (!menu) return;

    // Show/hide own-only items
    menu.querySelectorAll('.own-only').forEach(el => {
        el.style.display = isOwn ? '' : 'none';
    });

    menu.style.display = 'block';
    menu.dataset.ts = ts;
    menu.dataset.user = userId || '';

    // Position
    const menuRect = menu.getBoundingClientRect();
    if (x + menuRect.width > window.innerWidth) x = window.innerWidth - menuRect.width - 10;
    if (y + menuRect.height > window.innerHeight) y = window.innerHeight - menuRect.height - 10;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.position = 'fixed';

    setTimeout(() => {
        document.addEventListener('click', contextMenuOutsideClick);
    }, 50);
}

function contextMenuOutsideClick(e) {
    const menu = document.getElementById('context-menu');
    if (menu && !menu.contains(e.target)) {
        hideContextMenu();
    }
}

function hideContextMenu() {
    const menu = document.getElementById('context-menu');
    if (menu) menu.style.display = 'none';
    document.removeEventListener('click', contextMenuOutsideClick);
}

function showContextMenuForMessage(ts, userId, triggerEl) {
    const rect = triggerEl.getBoundingClientRect();
    showContextMenu(rect.left, rect.bottom + 4, ts, userId);
}

// ══════════════════════════════════════════
// ── User Profile Popover ──
// ══════════════════════════════════════════
async function showUserPopover(userId, triggerEl) {
    hideUserPopover();
    if (!userId) return;

    const popover = document.getElementById('user-profile-popup');
    if (!popover) return;

    popover.style.display = 'block';

    // Position
    const rect = triggerEl.getBoundingClientRect();
    let left = rect.right + 8;
    let top = rect.top;
    if (left + 280 > window.innerWidth) left = rect.left - 288;
    if (top + 300 > window.innerHeight) top = window.innerHeight - 310;
    if (left < 10) left = 10;
    if (top < 10) top = 10;
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
    popover.style.position = 'fixed';

    let user = state.users[userId];
    try {
        const fetched = await api(`/api/users/${userId}`);
        if (fetched && fetched.id) user = fetched;
    } catch (e) { /* use cached */ }

    if (!user) {
        document.getElementById('profile-name').textContent = 'User not found';
        return;
    }

    const avatar = user.avatar_local || user.avatar_url || '';
    const displayName = user.display_name || user.real_name || user.name || userId;
    const title = user.title || '';
    const status = user.status_text || '';
    const statusEmoji = user.status_emoji || '';

    const avatarEl = document.getElementById('profile-avatar');
    if (avatarEl) {
        avatarEl.src = avatar || '';
        avatarEl.style.display = avatar ? '' : 'none';
    }
    document.getElementById('profile-name').textContent = displayName;
    const titleEl = document.getElementById('profile-title');
    if (titleEl) titleEl.textContent = title;

    const statusEl = document.getElementById('profile-status');
    if (statusEl) {
        if (status) {
            statusEl.textContent = (statusEmoji ? getEmojiUnicode(statusEmoji.replace(/:/g, '')) + ' ' : '') + status;
            statusEl.style.display = '';
        } else {
            statusEl.style.display = 'none';
        }
    }

    // Set up message button
    const msgBtn = document.getElementById('btn-profile-message');
    if (msgBtn) {
        msgBtn.onclick = () => {
            messageUser(userId);
        };
    }

    popover.dataset.userId = userId;

    setTimeout(() => {
        document.addEventListener('click', userPopoverOutsideClick);
    }, 100);
}

function userPopoverOutsideClick(e) {
    const popover = document.getElementById('user-profile-popup');
    if (popover && !popover.contains(e.target)) {
        hideUserPopover();
    }
}

function hideUserPopover() {
    const popover = document.getElementById('user-profile-popup');
    if (popover) popover.style.display = 'none';
    document.removeEventListener('click', userPopoverOutsideClick);
}

function messageUser(userId) {
    hideUserPopover();
    const dmChannel = state.channels.find(ch =>
        (ch.is_dm) && (ch.user_id === userId || ch.name === userId)
    );
    if (dmChannel) {
        selectChannel(dmChannel);
    }
}

// ══════════════════════════════════════════
// ── Channel Details Panel ──
// ══════════════════════════════════════════
function toggleChannelDetails() {
    if (state.channelDetailOpen) {
        closeChannelDetails();
    } else {
        openChannelDetails();
    }
}

async function openChannelDetails() {
    if (!state.currentChannel) return;
    state.channelDetailOpen = true;

    const panel = document.getElementById('details-panel') || document.getElementById('channel-detail-panel');
    if (!panel) return;
    panel.style.display = 'flex';

    const ch = state.currentChannel;

    // Set title
    const titleEl = document.getElementById('details-title');
    if (titleEl) {
        titleEl.textContent = ch.is_dm ? (ch.display_name || ch.name) : '# ' + ch.name;
    }

    // About tab
    const aboutEl = document.getElementById('details-about');
    if (aboutEl) {
        aboutEl.innerHTML = `
            <div class="detail-section">
                <h4>Topic</h4>
                <p>${escapeHtml(ch.topic || 'No topic set')}</p>
            </div>
            <div class="detail-section">
                <h4>Purpose</h4>
                <p>${escapeHtml(ch.purpose || 'No purpose set')}</p>
            </div>
            <div class="detail-section">
                <h4>Created</h4>
                <p>${ch.created ? new Date(ch.created * 1000).toLocaleDateString() : 'Unknown'}</p>
            </div>
            ${ch.num_members ? `<div class="detail-section"><h4>Members</h4><p>${ch.num_members}</p></div>` : ''}
        `;
    }

    // Members tab
    loadChannelMembers();
}

async function loadChannelMembers() {
    const membersList = document.getElementById('details-members');
    if (!membersList) return;

    const users = Object.values(state.users);
    membersList.innerHTML = users.slice(0, 100).map(u => {
        const avatar = u.avatar_local || u.avatar_url;
        const name = u.display_name || u.real_name || u.name;
        return `<div class="detail-member-item" data-user-id="${u.id}">
            ${avatar
                ? `<img class="detail-member-avatar" src="${escapeHtml(avatar)}" alt="">`
                : `<div class="detail-member-avatar" style="background:#4a154b;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:12px">${(name || '?')[0].toUpperCase()}</div>`
            }
            <span class="detail-member-name">${escapeHtml(name || u.id)}</span>
        </div>`;
    }).join('');

    membersList.querySelectorAll('.detail-member-item').forEach(item => {
        item.addEventListener('click', () => {
            showUserPopover(item.dataset.userId, item);
        });
    });
}

function closeChannelDetails() {
    state.channelDetailOpen = false;
    const panel = document.getElementById('details-panel') || document.getElementById('channel-detail-panel');
    if (panel) panel.style.display = 'none';
}

function switchDetailTab(btn, tab) {
    const container = btn.closest('.details-panel, .channel-detail-panel') || document;
    container.querySelectorAll('.details-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    container.querySelectorAll('.details-tab-content').forEach(c => {
        c.classList.remove('active');
        c.style.display = 'none';
    });
    const content = document.getElementById(`details-${tab}`);
    if (content) {
        content.classList.add('active');
        content.style.display = '';
    }
}

// ══════════════════════════════════════════
// ── Composer Formatting Toolbar ──
// ══════════════════════════════════════════
function insertFormatting(type) {
    const textarea = document.getElementById('message-input');
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.substring(start, end);
    let before = '';
    let after = '';

    switch (type) {
        case 'bold':
            before = '*'; after = '*'; break;
        case 'italic':
            before = '_'; after = '_'; break;
        case 'strike':
            before = '~'; after = '~'; break;
        case 'code':
            before = '`'; after = '`'; break;
        case 'codeblock':
            before = '```\n'; after = '\n```'; break;
        case 'link':
            before = '<'; after = `|${selected || 'link text'}>`;
            break;
        case 'ol':
            before = '1. '; after = ''; break;
        case 'ul':
            before = '- '; after = ''; break;
    }

    if (type === 'link' && selected) {
        const replacement = `<${selected}|link text>`;
        textarea.value = textarea.value.substring(0, start) + replacement + textarea.value.substring(end);
    } else {
        const replacement = before + (selected || 'text') + after;
        textarea.value = textarea.value.substring(0, start) + replacement + textarea.value.substring(end);
    }

    textarea.focus();
    const newCursorPos = start + before.length + (selected || 'text').length;
    textarea.setSelectionRange(start + before.length, newCursorPos);
}

// ══════════════════════════════════════════
// ── @ Mention Autocomplete ──
// ══════════════════════════════════════════
function showMentionAutocomplete(query) {
    const users = Object.values(state.users);
    if (users.length === 0) {
        // Try loading users if not loaded yet
        loadUsers().then(() => {
            if (Object.values(state.users).length > 0) {
                showMentionAutocomplete(query);
            }
        });
        return;
    }

    const q = (query || '').toLowerCase();
    const matches = users.filter(u => {
        if (u.is_bot || u.deleted) return false;
        const name = (u.display_name || u.real_name || u.name || '').toLowerCase();
        const username = (u.name || '').toLowerCase();
        return !q || name.includes(q) || username.includes(q);
    }).slice(0, 10);

    if (matches.length === 0) {
        hideMentionAutocomplete();
        return;
    }

    const dropdown = document.getElementById('mention-autocomplete');
    if (!dropdown) return;

    const listEl = document.getElementById('mention-list') || dropdown;

    // Position above the active textarea (works for both main composer and edit textareas)
    const textarea = state.activeTextarea || document.getElementById('message-input');
    if (textarea) {
        const isEditTextarea = textarea.classList.contains('edit-message-input');
        if (isEditTextarea) {
            // Position near the edit textarea
            const rect = textarea.getBoundingClientRect();
            dropdown.style.position = 'fixed';
            dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
            dropdown.style.left = rect.left + 'px';
            dropdown.style.width = Math.min(rect.width, 360) + 'px';
        } else {
            const composerEl = textarea.closest('.composer') || textarea.parentElement;
            const rect = composerEl ? composerEl.getBoundingClientRect() : textarea.getBoundingClientRect();
            dropdown.style.position = 'fixed';
            dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
            dropdown.style.left = rect.left + 'px';
            dropdown.style.width = Math.min(rect.width, 360) + 'px';
        }
    }
    dropdown.style.display = 'block';
    state.mentionIndex = 0;

    listEl.innerHTML = matches.map((u, i) => {
        const avatar = u.avatar_local || u.avatar_url;
        const name = u.display_name || u.real_name || u.name || u.id;
        const handle = u.name || '';
        return `<div class="mention-item${i === 0 ? ' selected' : ''}" data-user-id="${u.id}" data-name="${escapeHtml(name)}">
            ${avatar ? `<img class="mention-avatar" src="${escapeHtml(avatar)}" alt="">` : `<div class="mention-avatar" style="background:#4a154b;color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border-radius:4px">${name[0].toUpperCase()}</div>`}
            <span class="mention-name">${escapeHtml(name)}</span>
            ${handle && handle !== name ? `<span style="color:#868686;font-size:12px;margin-left:4px">@${escapeHtml(handle)}</span>` : ''}
        </div>`;
    }).join('');

    listEl.querySelectorAll('.mention-item').forEach(item => {
        item.addEventListener('mousedown', (e) => {
            e.preventDefault(); // prevent blur
            selectMentionItem(item);
        });
    });
}

function hideMentionAutocomplete() {
    const dropdown = document.getElementById('mention-autocomplete');
    if (dropdown) dropdown.style.display = 'none';
    state.mentionIndex = -1;
}

function navigateMentionAutocomplete(direction) {
    const dropdown = document.getElementById('mention-autocomplete');
    if (!dropdown) return;
    const items = dropdown.querySelectorAll('.mention-item');
    if (items.length === 0) return;

    items.forEach(item => item.classList.remove('selected'));
    state.mentionIndex = (state.mentionIndex + direction + items.length) % items.length;
    items[state.mentionIndex].classList.add('selected');
    items[state.mentionIndex].scrollIntoView({ block: 'nearest' });
}

// Store mention mappings: @DisplayName → <@USER_ID>
if (!state.mentionMap) state.mentionMap = {};

function selectMentionItem(item) {
    const userId = item.dataset.userId;
    const displayName = item.dataset.name || userId;
    // Use the active textarea (main composer or edit textarea)
    const textarea = state.activeTextarea || document.getElementById('message-input');
    if (!textarea) return;

    const val = textarea.value;
    const pos = textarea.selectionStart;
    const textBefore = val.substring(0, pos);
    const matchStart = textBefore.lastIndexOf('@');

    if (matchStart >= 0) {
        const isEditMode = textarea.classList.contains('edit-message-input');
        if (isEditMode) {
            // In edit mode, insert the Slack format directly since the message will be sent as-is
            const slackText = `<@${userId}> `;
            textarea.value = val.substring(0, matchStart) + slackText + val.substring(pos);
            const newPos = matchStart + slackText.length;
            textarea.setSelectionRange(newPos, newPos);
        } else {
            // In composer, show @DisplayName and store mapping for send-time conversion
            const visibleText = `@${displayName} `;
            textarea.value = val.substring(0, matchStart) + visibleText + val.substring(pos);
            const newPos = matchStart + visibleText.length;
            textarea.setSelectionRange(newPos, newPos);
            state.mentionMap[`@${displayName}`] = `<@${userId}>`;
        }
    }

    hideMentionAutocomplete();
    hideEmojiAutocomplete();
    textarea.focus();
}

// ══════════════════════════════════════════
// ── Emoji Autocomplete ──
// ══════════════════════════════════════════
function showEmojiAutocomplete(query) {
    if (typeof EMOJI_DATA === 'undefined') return;
    const q = query.toLowerCase();
    const matches = Object.keys(EMOJI_DATA).filter(k => k.includes(q)).slice(0, 8);

    if (matches.length === 0) {
        hideEmojiAutocomplete();
        return;
    }

    let dropdown = document.getElementById('emoji-autocomplete');
    if (!dropdown) {
        dropdown = document.createElement('div');
        dropdown.className = 'emoji-autocomplete';
        dropdown.id = 'emoji-autocomplete';
        const composer = document.getElementById('composer') || document.getElementById('message-input-area');
        if (composer) composer.appendChild(dropdown);
    }
    dropdown.style.display = 'block';
    state.emojiAutocompleteIndex = 0;

    dropdown.innerHTML = matches.map((shortcode, i) => {
        return `<div class="emoji-ac-item${i === 0 ? ' selected' : ''}" data-shortcode="${shortcode}">
            <span class="emoji-ac-char">${EMOJI_DATA[shortcode]}</span>
            <span class="emoji-ac-name">:${shortcode}:</span>
        </div>`;
    }).join('');

    dropdown.querySelectorAll('.emoji-ac-item').forEach(item => {
        item.addEventListener('click', () => selectEmojiAutocompleteItem(item));
    });
}

function hideEmojiAutocomplete() {
    const dropdown = document.getElementById('emoji-autocomplete');
    if (dropdown) dropdown.style.display = 'none';
    state.emojiAutocompleteIndex = -1;
}

function navigateEmojiAutocomplete(direction) {
    const dropdown = document.getElementById('emoji-autocomplete');
    if (!dropdown) return;
    const items = dropdown.querySelectorAll('.emoji-ac-item');
    if (items.length === 0) return;

    items.forEach(item => item.classList.remove('selected'));
    state.emojiAutocompleteIndex = (state.emojiAutocompleteIndex + direction + items.length) % items.length;
    items[state.emojiAutocompleteIndex].classList.add('selected');
    items[state.emojiAutocompleteIndex].scrollIntoView({ block: 'nearest' });
}

function selectEmojiAutocompleteItem(item) {
    const shortcode = item.dataset.shortcode;
    const textarea = document.getElementById('message-input');
    if (!textarea) return;

    const val = textarea.value;
    const pos = textarea.selectionStart;
    const textBefore = val.substring(0, pos);
    const matchStart = textBefore.lastIndexOf(':');

    if (matchStart >= 0) {
        const emojiChar = getEmojiUnicode(shortcode);
        textarea.value = val.substring(0, matchStart) + emojiChar + ' ' + val.substring(pos);
        const newPos = matchStart + emojiChar.length + 1;
        textarea.setSelectionRange(newPos, newPos);
    }

    hideEmojiAutocomplete();
    trackFrequentEmoji(shortcode);
    textarea.focus();
}

// ══════════════════════════════════════════
// ── File Upload (Drag & Drop + Button) ──
// ══════════════════════════════════════════
function setupDragDrop() {
    const chatArea = document.querySelector('.chat-area');
    if (!chatArea) return;

    let dragCounter = 0;

    chatArea.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        showDropOverlay();
    });

    chatArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            hideDropOverlay();
        }
    });

    chatArea.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    chatArea.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        hideDropOverlay();
        const files = e.dataTransfer.files;
        if (files.length > 0 && state.currentChannel) {
            for (const file of files) {
                uploadFile(file);
            }
        }
    });
}

function showDropOverlay() {
    const overlay = document.getElementById('file-drop-overlay') || document.getElementById('drop-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function hideDropOverlay() {
    const overlay = document.getElementById('file-drop-overlay') || document.getElementById('drop-overlay');
    if (overlay) overlay.style.display = 'none';
}

// Stage 1: Show preview card with Send/Cancel — don't upload yet
function uploadFile(file) {
    if (!state.currentChannel) return;

    const icon = getFileIcon(file.name.split('.').pop() || '');
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');

    const stageId = 'staged-' + Date.now();
    const composer = document.getElementById('composer');

    // Store the file object for later
    window['_stagedFile_' + stageId] = file;

    let cardEl = document.createElement('div');
    cardEl.id = stageId;
    cardEl.className = 'upload-card upload-staged';

    // Generate preview
    let previewHtml = '';
    if (isImage) {
        const previewUrl = URL.createObjectURL(file);
        previewHtml = `<img class="upload-preview-img" src="${previewUrl}" alt="">`;
    } else if (isVideo) {
        const previewUrl = URL.createObjectURL(file);
        previewHtml = `<video class="upload-preview-img" src="${previewUrl}" muted style="max-height:120px"></video>`;
    }

    const channelName = state.currentChannel.is_dm
        ? (state.currentChannel.display_name || state.currentChannel.name)
        : '#' + state.currentChannel.name;

    cardEl.innerHTML = `
        ${previewHtml}
        <div class="upload-card-body">
            <div class="upload-card-info">
                <span class="upload-card-icon">${icon}</span>
                <div class="upload-card-details">
                    <div class="upload-card-name">${escapeHtml(file.name)}</div>
                    <div class="upload-card-meta">${formatFileSize(file.size)} · ${escapeHtml(file.type || 'file')}</div>
                </div>
                <button class="upload-cancel-btn" onclick="cancelStagedUpload('${stageId}')" title="Remove">✕</button>
            </div>
            <div class="upload-card-message">
                <input type="text" class="upload-message-input" id="${stageId}-msg" placeholder="Add a message about this file (optional)" autocomplete="off">
            </div>
            <div class="upload-card-actions">
                <span class="upload-card-dest">Upload to <strong>${escapeHtml(channelName)}</strong></span>
                <div class="upload-card-btns">
                    <button class="btn-secondary upload-card-cancel-btn" onclick="cancelStagedUpload('${stageId}')">Cancel</button>
                    <button class="btn-primary upload-card-send-btn" onclick="sendStagedFile('${stageId}')">
                        <svg viewBox="0 0 20 20" width="14" height="14" style="margin-right:4px"><path fill="currentColor" d="M1.5 2.25a.755.755 0 011-.71l15.596 7.808a.73.73 0 010 1.305L2.5 18.462a.755.755 0 01-1-.71V11.5L12 10 1.5 8.5V2.25z"/></svg>
                        Upload
                    </button>
                </div>
            </div>
        </div>
    `;

    // Insert above the composer
    if (composer) {
        composer.parentElement.insertBefore(cardEl, composer);
    }

    // Focus the message input
    setTimeout(() => {
        const msgInput = document.getElementById(`${stageId}-msg`);
        if (msgInput) msgInput.focus();
    }, 100);

    // Allow Enter to send
    const msgInput = cardEl.querySelector('.upload-message-input');
    if (msgInput) {
        msgInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendStagedFile(stageId);
            }
            if (e.key === 'Escape') {
                cancelStagedUpload(stageId);
            }
        });
    }
}

function cancelStagedUpload(stageId) {
    delete window['_stagedFile_' + stageId];
    const xhr = window['_xhr_' + stageId];
    if (xhr) { xhr.abort(); delete window['_xhr_' + stageId]; }
    const el = document.getElementById(stageId);
    if (el) {
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.2s';
        setTimeout(() => el?.remove(), 200);
    }
}

// Stage 2: Actually upload the file
async function sendStagedFile(stageId) {
    const file = window['_stagedFile_' + stageId];
    if (!file || !state.currentChannel) return;
    delete window['_stagedFile_' + stageId];

    const el = document.getElementById(stageId);
    if (!el) return;

    // Get optional message
    const msgInput = document.getElementById(`${stageId}-msg`);
    const message = msgInput ? msgInput.value.trim() : '';

    // Transform card into upload-in-progress state
    el.classList.remove('upload-staged');
    el.classList.add('upload-sending');
    const actionsArea = el.querySelector('.upload-card-actions');
    const msgArea = el.querySelector('.upload-card-message');
    if (actionsArea) actionsArea.innerHTML = '';
    if (msgArea) msgArea.innerHTML = '';

    const meta = el.querySelector('.upload-card-meta');
    if (meta) meta.textContent = `${formatFileSize(file.size)} · Uploading...`;

    // Add progress bar
    const bodyEl = el.querySelector('.upload-card-body');
    if (bodyEl) {
        const barHtml = document.createElement('div');
        barHtml.className = 'upload-bar-track';
        barHtml.innerHTML = `<div class="upload-bar-fill" id="${stageId}-bar"></div>`;
        bodyEl.appendChild(barHtml);
    }

    const cancelBtn = el.querySelector('.upload-cancel-btn');
    if (cancelBtn) cancelBtn.onclick = () => cancelStagedUpload(stageId);

    const formData = new FormData();
    formData.append('file', file);
    if (message) formData.append('title', message);

    const scroll = document.getElementById('messages-scroll');
    const xhr = new XMLHttpRequest();
    window['_xhr_' + stageId] = xhr;

    xhr.open('POST', `/api/channels/${state.currentChannel.id}/upload`);

    xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            const bar = document.getElementById(`${stageId}-bar`);
            if (bar) { bar.style.width = pct + '%'; bar.style.transition = 'width 0.2s ease'; }
            if (meta) {
                meta.textContent = pct < 100
                    ? `${formatFileSize(file.size)} · Uploading ${pct}%`
                    : `${formatFileSize(file.size)} · Processing...`;
            }
        }
    };

    xhr.onload = () => {
        delete window['_xhr_' + stageId];
        if (xhr.status === 200) {
            if (meta) meta.innerHTML = `${formatFileSize(file.size)} · <span style="color:#007a5a;font-weight:700">✓ Sent</span>`;
            const bar = el.querySelector('.upload-bar-fill');
            if (bar) { bar.style.width = '100%'; bar.style.background = '#007a5a'; }
            if (cancelBtn) cancelBtn.style.display = 'none';
            setTimeout(() => {
                el.style.opacity = '0'; el.style.transition = 'opacity 0.3s';
                setTimeout(() => el?.remove(), 300);
            }, 1500);

            // Send the optional message text as a separate message
            if (message && state.currentChannel) {
                fetch(`/api/channels/${state.currentChannel.id}/send`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: message })
                }).catch(() => {});
            }

            // Poll for new messages
            if (state.currentChannel && latestTs) {
                setTimeout(async () => {
                    const newMsgs = await api(`/api/channels/${state.currentChannel.id}/poll?since=${latestTs}`);
                    if (newMsgs.length > 0) {
                        for (const msg of newMsgs) {
                            if (!state.messages.find(m => m.ts === msg.ts)) {
                                state.messages.push(msg);
                            }
                        }
                        latestTs = state.messages[state.messages.length - 1].ts;
                        renderMessages();
                        if (scroll) scroll.scrollTop = scroll.scrollHeight;
                    }
                }, 2000);
            }
            showUploadToast(file.name + ' sent', true);
        } else {
            let errMsg = 'Upload failed';
            try { const r = JSON.parse(xhr.responseText); errMsg = r.error || errMsg; } catch (e) { errMsg = xhr.statusText || errMsg; }
            if (meta) meta.innerHTML = `<span style="color:#e01e5a;font-weight:700">✕ ${escapeHtml(errMsg)}</span>`;
            const bar = el.querySelector('.upload-bar-fill');
            if (bar) { bar.style.width = '100%'; bar.style.background = '#e01e5a'; }
            setTimeout(() => el?.remove(), 5000);
            showUploadToast(errMsg, false);
        }
    };

    xhr.onerror = () => {
        delete window['_xhr_' + stageId];
        if (meta) meta.innerHTML = '<span style="color:#e01e5a">✕ Network error</span>';
        setTimeout(() => el?.remove(), 4000);
        showUploadToast('Network error — file not sent', false);
    };

    xhr.send(formData);
}

function cancelUpload(id) {
    cancelStagedUpload(id);
}

function showUploadToast(message, success) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = 'position:fixed;top:52px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;max-width:360px;';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'notification-toast';
    toast.style.borderLeftColor = success ? '#007a5a' : '#e01e5a';
    toast.innerHTML = `
        <div style="display:flex;gap:10px;align-items:center">
            <span style="font-size:18px">${success ? '✅' : '❌'}</span>
            <span style="font-size:13px;color:#1d1c1d">${escapeHtml(message)}</span>
            <button onclick="this.closest('.notification-toast').remove()" style="background:none;border:none;font-size:16px;color:#999;cursor:pointer;padding:0;margin-left:auto">✕</button>
        </div>
    `;
    container.appendChild(toast);
    toast.style.animation = 'toastSlideIn 0.3s ease-out';
    setTimeout(() => {
        toast.style.animation = 'toastSlideOut 0.3s ease-in';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function triggerFileUpload() {
    const existing = document.getElementById('file-input');
    if (existing) {
        existing.value = '';
        existing.click();
        return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => {
        for (const file of input.files) {
            uploadFile(file);
        }
    };
    input.click();
}

// ══════════════════════════════════════════
// ── Typing Indicator ──
// ══════════════════════════════════════════
function showTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (!indicator) return;
    indicator.style.display = 'flex';
    clearTimeout(state.typingTimeout);
    state.typingTimeout = setTimeout(() => {
        indicator.style.display = 'none';
    }, 3000);
}

// ══════════════════════════════════════════
// ── Event Listeners ──
// ══════════════════════════════════════════
function setupEventListeners() {
    // Search
    document.getElementById('search-input').addEventListener('input', (e) => {
        clearTimeout(state.searchTimeout);
        state.searchTimeout = setTimeout(() => performSearch(e.target.value), 400);
    });
    document.getElementById('search-input').addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.target.value = '';
            document.getElementById('search-overlay').style.display = 'none';
        }
    });
    const closeSearchBtn = document.getElementById('btn-close-search');
    if (closeSearchBtn) {
        closeSearchBtn.addEventListener('click', () => {
            document.getElementById('search-overlay').style.display = 'none';
            document.getElementById('search-input').value = '';
        });
    }

    // Workspace switcher
    document.getElementById('workspace-switcher').addEventListener('click', (e) => {
        e.stopPropagation();
        const dd = document.getElementById('ws-dropdown');
        dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => {
        document.getElementById('ws-dropdown').style.display = 'none';
    });
    document.getElementById('ws-dropdown').addEventListener('click', (e) => {
        e.stopPropagation();
    });

    // Sync
    document.getElementById('btn-sync').addEventListener('click', () => {
        document.getElementById('sync-modal').style.display = 'flex';
        loadChannelPicker('modal');
    });
    const closeSyncBtn = document.getElementById('btn-close-sync');
    if (closeSyncBtn) {
        closeSyncBtn.addEventListener('click', () => {
            document.getElementById('sync-modal').style.display = 'none';
        });
    }
    document.getElementById('btn-start-sync').addEventListener('click', startSync);

    // Stats
    document.getElementById('btn-stats').addEventListener('click', showStats);
    const closeStatsBtn = document.getElementById('btn-close-stats');
    if (closeStatsBtn) {
        closeStatsBtn.addEventListener('click', () => {
            document.getElementById('stats-modal').style.display = 'none';
        });
    }

    // Thread
    document.getElementById('btn-close-thread').addEventListener('click', () => {
        document.getElementById('thread-panel').style.display = 'none';
    });

    // Load more
    document.getElementById('btn-load-more').addEventListener('click', () => {
        if (state.currentChannel) {
            loadMessages(state.currentChannel.id, true);
        }
    });

    // Lightbox — close on backdrop click or close button, NOT on content click
    document.querySelector('.lightbox-backdrop')?.addEventListener('click', () => {
        closeLightbox();
    });
    document.querySelector('.lightbox-close')?.addEventListener('click', () => {
        closeLightbox();
    });

    // Modal overlay clicks
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.style.display = 'none';
        });
    });

    // Sidebar section toggles
    document.querySelectorAll('.section-header').forEach(header => {
        header.addEventListener('click', () => {
            const targetId = header.dataset.toggle;
            const list = document.getElementById(targetId);
            header.classList.toggle('collapsed');
            list.classList.toggle('collapsed');
        });
    });

    // Setup wizard: Token show/hide toggle
    document.querySelectorAll('.btn-eye').forEach(btn => {
        btn.addEventListener('click', () => {
            const group = btn.closest('.token-input-group');
            const input = group?.querySelector('input');
            if (input) {
                input.type = input.type === 'password' ? 'text' : 'password';
            }
        });
    });

    // Setup wizard: Enter key in token input triggers connect
    const tokenInput = document.getElementById('setup-token-input');
    if (tokenInput) {
        tokenInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') connectSlack();
        });
    }
    const cookieInput = document.getElementById('setup-cookie-input');
    if (cookieInput) {
        cookieInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') connectSlack();
        });
        tokenInput?.addEventListener('input', () => {
            const val = tokenInput.value.trim();
            const cookieField = document.getElementById('cookie-field');
            if (val.startsWith('xoxc-')) {
                cookieField.style.display = 'flex';
            }
        });
    }

    // ── Message input handler ──
    const msgInput = document.getElementById('message-input');
    if (msgInput) {
        msgInput.addEventListener('keydown', handleMessageKeydown);
        msgInput.addEventListener('input', () => {
            checkComposerAutocomplete(msgInput);
        });
        msgInput.addEventListener('focus', () => {
            state.activeTextarea = msgInput;
        });
        state.activeTextarea = msgInput; // default
    }

    // ── Send button ──
    const sendBtn = document.getElementById('btn-send');
    if (sendBtn) {
        sendBtn.addEventListener('click', sendMessage);
    }

    // ── Message hover action bar (event delegation) ──
    const messagesContainer = document.getElementById('messages-list');
    if (messagesContainer) {
        messagesContainer.addEventListener('mouseover', (e) => {
            const msgEl = e.target.closest('.message:not(.system-message)');
            if (msgEl && !msgEl.querySelector('.msg-actions') && !state.editingMessageTs) {
                showMessageActions(msgEl);
            }
        });
        messagesContainer.addEventListener('mouseleave', () => {
            hideMessageActions();
        });
        messagesContainer.addEventListener('mouseout', (e) => {
            const relatedTarget = e.relatedTarget;
            if (relatedTarget && (relatedTarget.closest('.message') || relatedTarget.closest('.msg-actions'))) {
                return;
            }
            if (!relatedTarget || !messagesContainer.contains(relatedTarget)) {
                hideMessageActions();
            }
        });
    }

    // ── Right-click context menu on messages ──
    if (messagesContainer) {
        messagesContainer.addEventListener('contextmenu', (e) => {
            const msgEl = e.target.closest('.message:not(.system-message)');
            if (msgEl) {
                e.preventDefault();
                const ts = msgEl.dataset.ts;
                const userId = msgEl.dataset.user;
                showContextMenu(e.clientX, e.clientY, ts, userId);
            }
        });
    }

    // ── Context menu item clicks ──
    const ctxMenu = document.getElementById('context-menu');
    if (ctxMenu) {
        ctxMenu.addEventListener('click', (e) => {
            const item = e.target.closest('.context-menu-item');
            if (!item) return;
            const action = item.dataset.action;
            const ts = ctxMenu.dataset.ts;
            const userId = ctxMenu.dataset.user;

            if (action === 'copy') {
                const msg = state.messages.find(m => m.ts === ts);
                if (msg) {
                    navigator.clipboard.writeText(msg.text || '');
                    showToast('Message text copied');
                }
            } else if (action === 'reply') {
                if (state.currentChannel) openThread(state.currentChannel.id, ts);
            } else if (action === 'react') {
                const msgEl = document.querySelector(`.message[data-ts="${ts}"]`);
                if (msgEl) openReactionPickerForMessage(ts, msgEl);
            } else if (action === 'edit') {
                startEditMessage(ts);
            } else if (action === 'delete') {
                deleteMessage(ts);
            } else if (action === 'pin') {
                if (state.currentChannel) {
                    fetch(`/api/channels/${state.currentChannel.id}/pin`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ts, action: 'pin' })
                    }).then(r => r.json()).then(d => {
                        if (d.success) showToast('Message pinned');
                        else showToast('Failed to pin: ' + (d.error || 'unknown'));
                    });
                }
            }
            hideContextMenu();
        });
    }

    // ── Double-click to edit own message ──
    if (messagesContainer) {
        messagesContainer.addEventListener('dblclick', (e) => {
            const msgEl = e.target.closest('.message:not(.system-message)');
            if (msgEl && msgEl.dataset.user === state.currentUserId) {
                startEditMessage(msgEl.dataset.ts);
            }
        });
    }

    // ── User profile popover on avatar/name click ──
    document.addEventListener('click', (e) => {
        const avatarEl = e.target.closest('.message-avatar[data-user-id]');
        if (avatarEl && avatarEl.dataset.userId) {
            e.stopPropagation();
            showUserPopover(avatarEl.dataset.userId, avatarEl);
            return;
        }
        const senderEl = e.target.closest('.message-sender[data-user-id]');
        if (senderEl && senderEl.dataset.userId) {
            e.stopPropagation();
            showUserPopover(senderEl.dataset.userId, senderEl);
            return;
        }
        const mentionEl = e.target.closest('.mention[data-user-id]');
        if (mentionEl && mentionEl.dataset.userId) {
            e.stopPropagation();
            showUserPopover(mentionEl.dataset.userId, mentionEl);
            return;
        }
    });

    // ── Huddle button ──
    const huddleBtn = document.getElementById('btn-huddle');
    if (huddleBtn) {
        huddleBtn.addEventListener('click', () => {
            if (!state.currentChannel) return;
            const ws = get_active_workspace_id();
            const channelId = state.currentChannel.id;
            // Open the channel in Slack's web app — user can start huddle from there
            const slackUrl = `https://app.slack.com/client/${ws}/${channelId}`;
            window.open(slackUrl, '_blank');
        });
    }

    // ── Pins button ──
    const pinsBtn = document.getElementById('btn-pins');
    if (pinsBtn) {
        pinsBtn.addEventListener('click', async () => {
            if (!state.currentChannel) return;
            try {
                const pins = await api(`/api/channels/${state.currentChannel.id}/pins`);
                if (pins.error) {
                    showToast('Could not load pins: ' + pins.error);
                    return;
                }
                // Show pins in a simple modal-like overlay in the details panel
                const panel = document.getElementById('details-panel');
                const content = document.getElementById('details-about');
                if (panel && content) {
                    document.getElementById('details-title').textContent = 'Pinned Messages';
                    content.innerHTML = pins.length === 0
                        ? '<p style="color:#868686;text-align:center;padding:20px">No pinned messages in this channel.</p>'
                        : pins.map(p => {
                            const date = p.created ? new Date(p.created * 1000).toLocaleDateString() : '';
                            return `<div style="padding:10px 0;border-bottom:1px solid #f0f0f0">
                                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                                    ${p.user_avatar ? `<img src="${escapeHtml(p.user_avatar)}" style="width:24px;height:24px;border-radius:4px">` : ''}
                                    <strong>${escapeHtml(p.user_display_name || '')}</strong>
                                    <span style="font-size:11px;color:#868686">${date}</span>
                                </div>
                                <div style="font-size:14px;color:#1d1c1d">${escapeHtml(p.text || '').substring(0, 200)}</div>
                            </div>`;
                        }).join('');
                    // Show About tab content area with pins
                    document.querySelectorAll('.details-tab-content').forEach(t => t.classList.remove('active'));
                    content.classList.add('active');
                    document.querySelectorAll('.details-tab').forEach(t => t.classList.remove('active'));
                    panel.style.display = 'flex';
                }
            } catch (e) { showToast('Error loading pins'); }
        });
    }

    // ── Channel detail toggle button ──
    const detailBtn = document.getElementById('btn-channel-details');
    if (detailBtn) {
        detailBtn.addEventListener('click', toggleChannelDetails);
    }
    const closeDetailBtn = document.getElementById('btn-close-details');
    if (closeDetailBtn) {
        closeDetailBtn.addEventListener('click', closeChannelDetails);
    }
    const memberCountEl = document.getElementById('member-count');
    if (memberCountEl) {
        memberCountEl.style.cursor = 'pointer';
        memberCountEl.addEventListener('click', toggleChannelDetails);
    }

    // ── Details panel tabs ──
    document.querySelectorAll('.details-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            switchDetailTab(tab, tab.dataset.tab);
        });
    });

    // ── Composer formatting toolbar ──
    document.querySelectorAll('.composer-fmt-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            insertFormatting(btn.dataset.fmt);
        });
    });

    // ── Attach file button ──
    const attachBtn = document.getElementById('btn-attach');
    if (attachBtn) {
        attachBtn.addEventListener('click', triggerFileUpload);
    }
    const fileInput = document.getElementById('file-input');
    if (fileInput) {
        fileInput.addEventListener('change', () => {
            for (const file of fileInput.files) {
                uploadFile(file);
            }
            fileInput.value = '';
        });
    }

    // ── Emoji picker button in composer ──
    const emojiComposerBtn = document.getElementById('btn-emoji-composer');
    if (emojiComposerBtn) {
        emojiComposerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showEmojiPicker(emojiComposerBtn, (shortcode) => {
                const textarea = document.getElementById('message-input');
                if (textarea) {
                    const pos = textarea.selectionStart;
                    const emojiChar = getEmojiUnicode(shortcode);
                    textarea.value = textarea.value.substring(0, pos) + emojiChar + textarea.value.substring(pos);
                    textarea.focus();
                    const newPos = pos + emojiChar.length;
                    textarea.setSelectionRange(newPos, newPos);
                }
            });
        });
    }

    // ── Mention button in composer ──
    const mentionBtn = document.getElementById('btn-mention');
    if (mentionBtn) {
        mentionBtn.addEventListener('click', () => {
            const textarea = document.getElementById('message-input');
            if (textarea) {
                const pos = textarea.selectionStart;
                textarea.value = textarea.value.substring(0, pos) + '@' + textarea.value.substring(pos);
                textarea.focus();
                textarea.setSelectionRange(pos + 1, pos + 1);
                showMentionAutocomplete('');
            }
        });
    }

    // ── Keyboard shortcuts ──
    document.addEventListener('keydown', (e) => {
        // ESC closes everything
        if (e.key === 'Escape') {
            hideEmojiPicker();
            hideContextMenu();
            hideUserPopover();
            hideMentionAutocomplete();
            hideEmojiAutocomplete();
            closeLightbox();
            document.getElementById('search-overlay').style.display = 'none';
            document.getElementById('thread-panel').style.display = 'none';
            document.getElementById('stats-modal').style.display = 'none';
            document.getElementById('sync-modal').style.display = 'none';
            const confirmModal = document.getElementById('confirm-modal');
            if (confirmModal) confirmModal.style.display = 'none';
            closeChannelDetails();
            if (state.editingMessageTs) {
                cancelEditMessage(state.editingMessageTs);
            }
        }

        // Ctrl+K / Cmd+K: Focus search
        if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            document.getElementById('search-input').focus();
        }

        // Formatting shortcuts in composer
        const activeEl = document.activeElement;
        if (activeEl && activeEl.id === 'message-input') {
            if (e.key === 'b' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                insertFormatting('bold');
            }
            if (e.key === 'i' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                insertFormatting('italic');
            }
            if (e.key === 's' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
                e.preventDefault();
                insertFormatting('strike');
            }
        }
    });
}

// ── Utility functions ──
function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatDate(date) {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

    const options = { weekday: 'long', month: 'long', day: 'numeric' };
    if (date.getFullYear() !== today.getFullYear()) {
        options.year = 'numeric';
    }
    return date.toLocaleDateString('en-US', options);
}

function formatTime(date) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getFileIcon(type) {
    const icons = {
        pdf: '\u{1F4C4}', doc: '\u{1F4DD}', docx: '\u{1F4DD}', xls: '\u{1F4CA}', xlsx: '\u{1F4CA}',
        ppt: '\u{1F4CE}', pptx: '\u{1F4CE}', zip: '\u{1F4E6}', rar: '\u{1F4E6}', tar: '\u{1F4E6}',
        mp3: '\u{1F3B5}', wav: '\u{1F3B5}', mp4: '\u{1F3AC}', mov: '\u{1F3AC}', avi: '\u{1F3AC}',
        py: '\u{1F40D}', js: '\u{1F4DC}', ts: '\u{1F4DC}', html: '\u{1F310}', css: '\u{1F3A8}',
        json: '\u{1F4CB}', xml: '\u{1F4CB}', csv: '\u{1F4CA}', txt: '\u{1F4DD}', md: '\u{1F4DD}',
        png: '\u{1F5BC}\uFE0F', jpg: '\u{1F5BC}\uFE0F', jpeg: '\u{1F5BC}\uFE0F', gif: '\u{1F5BC}\uFE0F', svg: '\u{1F5BC}\uFE0F',
    };
    return icons[type] || '\u{1F4CE}';
}
