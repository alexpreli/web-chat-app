let currentUser = null;
let isLoginMode = true;

const ANTI_SPAM_FAST_SEND_WINDOW_MS = 1000;
const ANTI_SPAM_MAX_CONSECUTIVE_FAST = 3;
const ANTI_SPAM_LOCKOUT_MS = 5000;
const FIRESTORE_DOC_SOFT_LIMIT_BYTES = 900 * 1024;
const MAX_IMAGE_FILE_BYTES = 450 * 1024;
const MAX_VIDEO_FILE_BYTES = 650 * 1024;
const MAX_AUDIO_FILE_BYTES = 500 * 1024;
const antiSpamState = {
    text: { lastSentAt: 0, consecutiveFast: 0, lockedUntil: 0 },
    sticker: { lastSentAt: 0, consecutiveFast: 0, lockedUntil: 0 },
    gif: { lastSentAt: 0, consecutiveFast: 0, lockedUntil: 0 }
};

function getAntiSpamLabel(kind) {
    if (kind === 'sticker') return 'sticker';
    if (kind === 'gif') return 'GIF';
    return 'message';
}

function antiSpamTryConsume(kind) {
    const state = antiSpamState[kind];
    if (!state) return { allowed: true };

    const now = Date.now();
    if (state.lockedUntil && now < state.lockedUntil) {
        const remainingSeconds = Math.ceil((state.lockedUntil - now) / 1000);
        return {
            allowed: false,
            remainingSeconds,
            message: `Please wait ${remainingSeconds} seconds before sending another ${getAntiSpamLabel(kind)}.`
        };
    }

    const delta = state.lastSentAt ? (now - state.lastSentAt) : Number.POSITIVE_INFINITY;
    if (delta < ANTI_SPAM_FAST_SEND_WINDOW_MS) {
        state.consecutiveFast += 1;
    } else {
        state.consecutiveFast = 1;
    }
    state.lastSentAt = now;

    if (state.consecutiveFast >= ANTI_SPAM_MAX_CONSECUTIVE_FAST) {
        state.lockedUntil = now + ANTI_SPAM_LOCKOUT_MS;
        state.consecutiveFast = 0;
        const remainingSeconds = Math.ceil(ANTI_SPAM_LOCKOUT_MS / 1000);
        return {
            allowed: false,
            remainingSeconds,
            message: `Too fast — wait ${remainingSeconds} seconds before sending another ${getAntiSpamLabel(kind)}.`
        };
    }

    return { allowed: true };
}
let userColors = [
    'user-color-1', 'user-color-2', 'user-color-3', 'user-color-4', 'user-color-5',
    'user-color-6', 'user-color-7', 'user-color-8', 'user-color-9', 'user-color-10'
];

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordingStartTime = null;

function getUserDailyColor(username) {
    const today = new Date().toISOString().split('T')[0];

    const hashString = username + today;
    let hash = 0;
    for (let i = 0; i < hashString.length; i++) {
        const char = hashString.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }

    const colorIndex = Math.abs(hash) % userColors.length;
    return userColors[colorIndex];
}

function getMessagesScrollContainer() {
    const messagesList = document.getElementById('messagesList');
    if (!messagesList) return null;
    return messagesList.closest('.messages-container') || messagesList;
}

function scrollMessagesToBottom() {
    const scrollContainer = getMessagesScrollContainer();
    if (!scrollContainer) return;

    scrollContainer.scrollTop = scrollContainer.scrollHeight;

    setTimeout(() => {
        scrollContainer.scrollTo({
            top: scrollContainer.scrollHeight,
            behavior: 'smooth'
        });
    }, 50);
}

function setupAutoScrollForMessages() {
    const messagesList = document.getElementById('messagesList');
    if (!messagesList) return;

    scrollMessagesToBottom();

    const observer = new MutationObserver((records) => {
        for (const r of records) {
            if (r.target !== messagesList || r.type !== 'childList') continue;
            const added = r.addedNodes.length;
            const removed = r.removedNodes.length;
            if (added > 0 && removed === 0) {
                scrollMessagesToBottom();
                return;
            }
        }
    });

    observer.observe(messagesList, { childList: true });

    window.messagesAutoScrollObserver = observer;
}

function forceScrollToLatestMessage() {
    const scrollContainer = getMessagesScrollContainer();
    if (!scrollContainer) return;

    const scrollToBottom = () => {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        scrollContainer.scrollTo({
            top: scrollContainer.scrollHeight,
            behavior: 'auto'
        });
    };

    scrollToBottom();
    requestAnimationFrame(scrollToBottom);
    setTimeout(scrollToBottom, 50);
    setTimeout(scrollToBottom, 150);
}

document.addEventListener('DOMContentLoaded', () => {
    setTimeout(setupAutoScrollForMessages, 50);
});

const GIPHY_API_KEY = 'YOUR_GIPHY_API_KEY';

function getGiphyApiKey() {
    if (typeof window !== 'undefined' && window.GIPHY_API_KEY) {
        return String(window.GIPHY_API_KEY).trim();
    }
    return String(GIPHY_API_KEY || '').trim();
}

function getGiphyApiErrorHint() {
    return 'Add your GIPHY API key: open script.js and set GIPHY_API_KEY, or set window.GIPHY_API_KEY before script.js loads. Free key: https://developers.giphy.com/dashboard/';
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function estimateBase64Length(rawBytes) {
    return Math.ceil(rawBytes / 3) * 4;
}

function validateFirestoreInlineMediaSize(file, maxFileBytes, label) {
    if (!file || typeof file.size !== 'number') return false;
    if (file.size > maxFileBytes) {
        alert(`${label} is too large. Maximum allowed is ${Math.floor(maxFileBytes / 1024)}KB.`);
        return false;
    }
    const estimatedDataUrlSize = estimateBase64Length(file.size) + 128;
    if (estimatedDataUrlSize > FIRESTORE_DOC_SOFT_LIMIT_BYTES) {
        alert(`${label} is too large to store inline in Firestore. Please choose a smaller file.`);
        return false;
    }
    return true;
}

function isSameUserIdentity(value, uid, username) {
    const candidate = String(value ?? '').trim();
    if (!candidate) return false;
    const normalizedCandidate = candidate.toLowerCase();
    const normalizedUid = String(uid ?? '').trim().toLowerCase();
    const normalizedUsername = String(username ?? '').trim().toLowerCase();
    if (normalizedUid && normalizedCandidate === normalizedUid) return true;
    if (normalizedUsername && normalizedCandidate === normalizedUsername) return true;
    return false;
}

function normalizeIdentityKey(value) {
    return String(value ?? '').trim().toLowerCase();
}

function getCurrentUserIdentityAliases() {
    if (!currentUser) return [];
    const aliases = [];
    if (currentUser.uid) aliases.push(String(currentUser.uid));
    if (currentUser.username) aliases.push(String(currentUser.username));
    if (currentUser.email && String(currentUser.email).includes('@')) {
        aliases.push(String(currentUser.email).split('@')[0]);
        aliases.push(String(currentUser.email));
    }
    return aliases;
}

function isCurrentUserIdentity(value) {
    const aliases = getCurrentUserIdentityAliases();
    return aliases.some((alias) => isSameUserIdentity(value, alias, alias));
}

function getOwnReactionEmojiFromMap(reactionsByUid) {
    if (!reactionsByUid || typeof reactionsByUid !== 'object' || !currentUser?.uid) return null;
    const uid = currentUser.uid;
    if (Object.prototype.hasOwnProperty.call(reactionsByUid, uid)) {
        const v = reactionsByUid[uid];
        if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    const nu = normalizeIdentityKey(uid);
    for (const [k, v] of Object.entries(reactionsByUid)) {
        if (normalizeIdentityKey(k) === nu || isSameUserIdentity(k, uid, currentUser.username)) {
            if (v != null && String(v).trim() !== '') return String(v).trim();
        }
    }
    return null;
}

function countValidReactionsByUidEntries(reactionsByUid) {
    if (!reactionsByUid || typeof reactionsByUid !== 'object') return 0;
    return Object.keys(reactionsByUid).filter((k) => {
        const v = reactionsByUid[k];
        return v != null && String(v).trim() !== '';
    }).length;
}

function byUidAlreadyHasIdentity(byUid, identityToken) {
    const t = String(identityToken ?? '').trim();
    if (!t) return false;
    if (Object.prototype.hasOwnProperty.call(byUid, t)) return true;
    const nt = normalizeIdentityKey(t);
    for (const k of Object.keys(byUid)) {
        if (normalizeIdentityKey(k) === nt) return true;
        if (isSameUserIdentity(t, k, k)) return true;
    }
    return false;
}

function looksLikeFirebaseUidKey(key) {
    const s = String(key ?? '').trim();
    return s.length >= 20 && /^[a-zA-Z0-9]+$/.test(s);
}

const usernameDirectoryCache = {};

function fallbackUidDisplayLabel(uid) {
    const u = String(uid ?? '');
    if (!u) return '?';
    if (u.length <= 8) return u;
    return `…${u.slice(-6)}`;
}

async function fetchUsernameForUid(uid) {
    const u = String(uid ?? '').trim();
    if (!u || !looksLikeFirebaseUidKey(u) || !db) return null;
    if (usernameDirectoryCache[u]) return usernameDirectoryCache[u];
    try {
        const usersCol = firebase.collection(db, 'users');
        const ref = firebase.doc(usersCol, u);
        const snap = await firebase.getDoc(ref);
        if (snap.exists()) {
            const name = String(snap.data()?.username ?? '').trim();
            if (name) {
                usernameDirectoryCache[u] = name;
                return name;
            }
        }
    } catch (e) {
        console.warn('fetchUsernameForUid', e);
    }
    return null;
}

async function prefetchUsernamesForReactionMaps(messageObjs) {
    if (!db || !Array.isArray(messageObjs)) return;
    const need = new Set();
    for (const msg of messageObjs) {
        if (!msg) continue;
        const rb = msg.reactionsByUid;
        if (!rb || typeof rb !== 'object') continue;
        const names = msg.reactionNamesByUid && typeof msg.reactionNamesByUid === 'object' ? msg.reactionNamesByUid : {};
        for (const k of Object.keys(rb)) {
            if (String(rb[k] ?? '').trim() === '') continue;
            if (!looksLikeFirebaseUidKey(k)) continue;
            if (names[k] != null && String(names[k]).trim() !== '') continue;
            if (usernameDirectoryCache[k]) continue;
            need.add(k);
        }
    }
    await Promise.all([...need].map((id) => fetchUsernameForUid(id)));
}

function mergeReactionNamesForDisplay(messageObj) {
    const merged = {
        ...(messageObj.reactionNamesByUid && typeof messageObj.reactionNamesByUid === 'object'
            ? messageObj.reactionNamesByUid
            : {})
    };
    const rb = messageObj.reactionsByUid;
    if (!rb || typeof rb !== 'object') return merged;
    for (const k of Object.keys(rb)) {
        if (String(rb[k] ?? '').trim() === '') continue;
        if (merged[k] != null && String(merged[k]).trim() !== '') continue;
        if (!looksLikeFirebaseUidKey(k)) {
            merged[k] = String(k);
        } else {
            const c = usernameDirectoryCache[k];
            merged[k] = (c && String(c).trim()) || fallbackUidDisplayLabel(k);
        }
    }
    return merged;
}

async function publishCurrentUserProfile() {
    if (!db || !currentUser?.uid) return;
    try {
        const usersCol = firebase.collection(db, 'users');
        const ref = firebase.doc(usersCol, currentUser.uid);
        await firebase.setDoc(ref, { username: currentUser.username }, { merge: true });
        usernameDirectoryCache[currentUser.uid] = currentUser.username;
    } catch (e) {
        console.warn('publishCurrentUserProfile', e);
    }
}

function displayNameForReactionUser(mapKey, reactionNamesByUid) {
    const k = String(mapKey ?? '').trim();
    if (!k) return 'Unknown';
    if (isSameUserIdentity(k, currentUser?.uid, currentUser?.username)) {
        return 'You';
    }
    const names = reactionNamesByUid && typeof reactionNamesByUid === 'object' ? reactionNamesByUid : null;
    if (names && names[k] != null && String(names[k]).trim() !== '') {
        return String(names[k]).trim();
    }
    if (!looksLikeFirebaseUidKey(k)) return k;
    const cached = usernameDirectoryCache[k];
    if (cached && String(cached).trim() !== '') return String(cached).trim();
    return fallbackUidDisplayLabel(k);
}

function renderGiphyResultsToGrid(gifGrid, data) {
    if (!gifGrid || !Array.isArray(data) || data.length === 0) return;
    gifGrid.innerHTML = '';
    data.forEach((gif, index) => {
        const still = gif.images.fixed_height_still?.url || gif.images.fixed_height?.url;
        const original = gif.images.original?.url || gif.images.fixed_height?.url;
        if (!still || !original) return;
        const gifItem = document.createElement('div');
        gifItem.className = 'gif-item';
        gifItem.innerHTML = `
            <img src="${still}" alt="GIPHY GIF ${index + 1}" loading="lazy">
            <div class="gif-overlay">
                <i class="fas fa-play"></i>
            </div>
        `;
        gifItem.addEventListener('click', () => sendGif(original));
        gifGrid.appendChild(gifItem);
    });
    gifGrid.scrollTop = 0;
    gifGrid.scrollLeft = 0;
}

async function fetchGiphyJson(url) {
    const response = await fetch(url);
    let data = null;
    try {
        data = await response.json();
    } catch {
        data = null;
    }
    const apiMsg = data && data.meta && data.meta.msg ? data.meta.msg : null;
    if (!response.ok) {
        const detail = apiMsg || `${response.status} ${response.statusText}`;
        throw new Error(detail);
    }
    return data;
}

let firebase = null;
let auth = null;
let db = null;
let messagesUnsubscribe = null;
let sessionClearAfter = null;
let permanentClearAfter = null;

const emojiCategories = {
    smileys: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈', '👿', '👹', '👺', '🤡', '💩', '👻', '💀', '☠️', '👽', '👾', '🤖', '🎃', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾'],
    hearts: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '♥️', '💯', '💢', '💥', '💫', '💦', '💨', '🕳️', '💣', '💤', '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '👊', '✊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🦷', '🦴', '👀', '👁️', '👅', '👄', '💋', '🩸'],
    gestures: ['👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '👊', '✊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏'],
    objects: ['🎉', '🎊', '🎈', '🎁', '🎀', '🎂', '🍰', '🧁', '🍭', '🍬', '🍫', '🍪', '🍩', '🍨', '🍧', '🍦', '🥧', '🍕', '🌮', '🌯', '🥙', '🥗', '🥘', '🍲', '🍛', '🍜', '🍝', '🍠', '🍢', '🍣', '🍤', '🍥', '🥮', '🍡', '🥟', '🥠', '🥡', '🦀', '🦞', '🦐', '🦑', '🦪', '🍦', '🍧', '🍨', '🍩', '🍪', '🎂', '🍰', '🧁', '🥧', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪', '🎂', '🍰', '🧁', '🥧', '🍮', '🍭', '🍬', '🍫', '🍿', '🥜', '🌰', '🍯', '🥛', '🍼', '☕', '🍵', '🧃', '🥤', '🍶', '🍺', '🍻', '🥂', '🍷', '🥃', '🍸', '🍹', '🧉', '🍾', '🧊', '🥄', '🍴', '🍽️', '🥣', '🥡', '🥢', '🧂']
};

document.addEventListener('DOMContentLoaded', function () {
    const authModal = document.getElementById('authModal');
    if (authModal) authModal.style.display = 'none';
    setupEventListeners();
    startAppInitialization();
});

function startAppInitialization(attempt = 0) {
    const MAX_INIT_ATTEMPTS = 40;
    const RETRY_DELAY_MS = 50;

    const initialized = initializeApp();
    if (initialized) return;

    if (attempt >= MAX_INIT_ATTEMPTS) {
        console.error('Firebase failed to initialize in time');
        showAuthModal();
        return;
    }

    setTimeout(() => startAppInitialization(attempt + 1), RETRY_DELAY_MS);
}

function initializeApp() {
    firebase = window.firebase;
    if (!firebase) {
        return false;
    }

    auth = firebase.auth;
    db = firebase.db;

    firebase.onAuthStateChanged(auth, (user) => {
        if (user) {
            currentUser = {
                uid: user.uid,
                username: user.displayName || user.email.split('@')[0],
                email: user.email,
                colorClass: getUserDailyColor(user.displayName || user.email.split('@')[0])
            };
            usernameDirectoryCache[currentUser.uid] = currentUser.username;
            void publishCurrentUserProfile();
            loadPermanentClearState();
            showChatInterface();
            setupRealtimeMessages();
        } else {
            currentUser = null;
            sessionClearAfter = null;
            permanentClearAfter = null;
            showAuthModal();
        }
    });

    initializeEmojiPicker();

    return true;
}

function setupRealtimeMessages() {
    if (!db) return;

    if (messagesUnsubscribe) {
        messagesUnsubscribe();
        messagesUnsubscribe = null;
    }

    const messagesList = document.getElementById('messagesList');
    messagesList.innerHTML = '';

    const processedMessages = new Set();

    const messagesRef = firebase.collection(db, 'messages');
    const q = firebase.query(messagesRef, firebase.orderBy('timestamp', 'asc'));

    messagesUnsubscribe = firebase.onSnapshot(q, (snapshot) => {
        void (async () => {
            const wasInitialLoad = messagesList.children.length === 0;
            const scrollContainer = getMessagesScrollContainer();
            if (!scrollContainer) return;
            const wasAtBottom = scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 10;
            let shouldForceScroll = false;

            const pending = [];
            for (const change of snapshot.docChanges()) {
                const docId = change.doc.id;
                const messageData = change.doc.data();
                const messageObj = {
                    id: docId,
                    sender: messageData.sender,
                    text: messageData.text,
                    timestamp: messageData.timestamp?.toDate?.() || new Date(messageData.timestamp),
                    type: messageData.type || 'text',
                    colorClass: messageData.colorClass || 'user-color-1',
                    mediaUrl: messageData.mediaUrl,
                    duration: messageData.duration,
                    reactions: messageData.reactions,
                    reactionsByUid: messageData.reactionsByUid,
                    reactionNamesByUid: messageData.reactionNamesByUid
                };
                if (messageObj.type === 'system') {
                    continue;
                }

                const clearCutoff = Math.max(sessionClearAfter || 0, permanentClearAfter || 0);
                if (clearCutoff && messageObj.timestamp && messageObj.timestamp.getTime() <= clearCutoff) {
                    const existing = messagesList.querySelector(`[data-message-id="${docId}"]`);
                    if (existing) existing.parentNode.removeChild(existing);
                    continue;
                }

                pending.push({ change, messageObj, docId });
            }

            await prefetchUsernamesForReactionMaps(pending.map((p) => p.messageObj));

            for (const { change, messageObj, docId } of pending) {
                const enriched = {
                    ...messageObj,
                    reactionNamesByUid: mergeReactionNamesForDisplay(messageObj)
                };

                if (change.type === 'added' && !processedMessages.has(docId)) {
                    const node = createMessageElement(enriched);
                    messagesList.appendChild(node);
                    processedMessages.add(docId);
                    if (messageObj.sender === currentUser.username) {
                        shouldForceScroll = true;
                    }
                } else if (change.type === 'modified') {
                    const existing = messagesList.querySelector(`[data-message-id="${docId}"]`);
                    const node = createMessageElement(enriched);
                    if (existing) {
                        existing.parentNode.replaceChild(node, existing);
                    } else {
                        messagesList.appendChild(node);
                    }
                }
            }

            if (wasInitialLoad) {
                forceScrollToLatestMessage();
            } else if ((wasAtBottom && snapshot.docChanges().length > 0) || shouldForceScroll) {
                forceScrollToLatestMessage();
            }
        })();
    });
}

function setupEventListeners() {
    document.getElementById('authForm').addEventListener('submit', handleAuth);
    document.getElementById('authSwitchLink').addEventListener('click', toggleAuthMode);

    document.getElementById('sendBtn').addEventListener('click', sendMessage);
    document.getElementById('voiceBtn').addEventListener('click', toggleVoiceRecording);
    document.getElementById('messageInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            sendMessage();
        }
    });

    document.getElementById('imageBtn').addEventListener('click', async () => {
        const imageInput = document.getElementById('imageInput');
        imageInput.accept = 'image/*,.jpg,.jpeg,.png,.gif,.webp,.bmp,.svg';
        const pickedResult = await pickStrictFile({
            description: 'Image Files',
            accept: {
                'image/*': ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']
            },
            startIn: 'downloads'
        });
        if (pickedResult.file) {
            handleImageFile(pickedResult.file);
            return;
        }
        if (pickedResult.shouldFallback) {
            imageInput.click();
        }
    });
    document.getElementById('videoBtn').addEventListener('click', async () => {
        const videoInput = document.getElementById('videoInput');
        videoInput.accept = 'video/*,.mp4,.webm,.mov,.avi,.mkv,.m4v';
        const pickedResult = await pickStrictFile({
            description: 'Video Files',
            accept: {
                'video/*': ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v']
            },
            startIn: 'videos'
        });
        if (pickedResult.file) {
            handleVideoFile(pickedResult.file);
            return;
        }
        if (pickedResult.shouldFallback) {
            videoInput.click();
        }
    });

    document.getElementById('imageInput').addEventListener('change', handleImageUpload);
    document.getElementById('videoInput').addEventListener('change', handleVideoUpload);

    document.getElementById('gifSearchBtn').addEventListener('click', searchGifs);
    document.getElementById('gifSearch').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            searchGifs();
        }
    });

    document.addEventListener('click', function (e) {
        const clickedEmojiBtn = !!e.target.closest('#emojiBtn');
        const clickedGifBtn = !!e.target.closest('#gifBtn');
        const clickedStickerBtn = !!e.target.closest('#stickerBtn');
        const insideEmojiPicker = !!e.target.closest('.emoji-picker');
        const insideGifPicker = !!e.target.closest('.gif-picker');
        const insideStickerPicker = !!e.target.closest('.sticker-picker');

        if (!insideEmojiPicker && !clickedEmojiBtn) {
            const emojiPickerEl = document.getElementById('emojiPicker');
            if (emojiPickerEl) emojiPickerEl.style.display = 'none';
        }
        if (!insideGifPicker && !clickedGifBtn) {
            const gifPickerEl = document.getElementById('gifPicker');
            if (gifPickerEl) gifPickerEl.style.display = 'none';
        }
        if (!insideStickerPicker && !clickedStickerBtn) {
            const stickerPickerEl = document.getElementById('stickerPicker');
            if (stickerPickerEl) stickerPickerEl.style.display = 'none';
        }
    });
}

function showAuthModal() {
    document.getElementById('authModal').style.display = 'flex';
    document.getElementById('chatApp').style.display = 'none';
    clearAuthError();
    applyAuthModeUI();
}

function showChatInterface() {
    document.getElementById('authModal').style.display = 'none';
    document.getElementById('chatApp').style.display = 'flex';

    document.getElementById('currentUsername').textContent = currentUser.username;
    document.getElementById('userAvatar').textContent = currentUser.username.charAt(0).toUpperCase();
    document.getElementById('userAvatar').className = `user-avatar ${currentUser.colorClass}`;

    setupChatEventListeners();
    forceScrollToLatestMessage();
}

function setupChatEventListeners() {
    const emojiBtn = document.getElementById('emojiBtn');
    const gifBtn = document.getElementById('gifBtn');
    const clearBtn = document.getElementById('clearBtn');
    const clearAllBtn = document.getElementById('clearAllBtn');
    const refreshMessagesBtn = document.getElementById('refreshMessagesBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const stickerBtn = document.getElementById('stickerBtn');

    const newEmojiBtn = emojiBtn.cloneNode(true);
    const newGifBtn = gifBtn.cloneNode(true);
    const newClearBtn = clearBtn.cloneNode(true);
    const newClearAllBtn = clearAllBtn ? clearAllBtn.cloneNode(true) : null;
    const newRefreshMessagesBtn = refreshMessagesBtn ? refreshMessagesBtn.cloneNode(true) : null;
    const newLogoutBtn = logoutBtn.cloneNode(true);
    const newStickerBtn = stickerBtn ? stickerBtn.cloneNode(true) : null;

    emojiBtn.parentNode.replaceChild(newEmojiBtn, emojiBtn);
    gifBtn.parentNode.replaceChild(newGifBtn, gifBtn);
    clearBtn.parentNode.replaceChild(newClearBtn, clearBtn);
    if (clearAllBtn && newClearAllBtn) clearAllBtn.parentNode.replaceChild(newClearAllBtn, clearAllBtn);
    if (refreshMessagesBtn && newRefreshMessagesBtn) refreshMessagesBtn.parentNode.replaceChild(newRefreshMessagesBtn, refreshMessagesBtn);
    logoutBtn.parentNode.replaceChild(newLogoutBtn, logoutBtn);
    if (stickerBtn && newStickerBtn) stickerBtn.parentNode.replaceChild(newStickerBtn, stickerBtn);

    newEmojiBtn.addEventListener('click', toggleEmojiPicker);
    newGifBtn.addEventListener('click', toggleGifPicker);
    newClearBtn.addEventListener('click', clearMessages);
    if (newClearAllBtn) newClearAllBtn.addEventListener('click', clearAllMessagesPermanentlyLocal);
    if (newRefreshMessagesBtn) newRefreshMessagesBtn.addEventListener('click', refreshAllMessagesFromDatabase);
    newLogoutBtn.addEventListener('click', logout);
    if (newStickerBtn) newStickerBtn.addEventListener('click', toggleStickerPicker);
}

function toggleAuthMode(e) {
    e.preventDefault();
    isLoginMode = !isLoginMode;
    clearAuthError();
    applyAuthModeUI();
}

function applyAuthModeUI() {
    const title = document.getElementById('authTitle');
    const button = document.getElementById('authButton');
    const switchText = document.getElementById('authSwitchText');
    const switchLink = document.getElementById('authSwitchLink');
    const passwordGroup = document.getElementById('passwordGroup');
    const passwordField = document.getElementById('password');
    const usernameField = document.getElementById('username');
    if (!title || !button || !switchText || !switchLink || !passwordGroup || !passwordField || !usernameField) {
        return;
    }

    passwordField.value = '';
    passwordGroup.style.display = 'block';
    passwordField.required = true;
    usernameField.placeholder = 'Email';

    if (isLoginMode) {
        title.textContent = 'Welcome back!';
        button.textContent = 'Login';
        switchText.textContent = 'Don\'t have an account?';
        switchLink.textContent = 'Create account';
    } else {
        title.textContent = 'Create new account';
        button.textContent = 'Create account';
        switchText.textContent = 'Already have an account?';
        switchLink.textContent = 'Login here';
    }
}

function handleAuth(e) {
    e.preventDefault();
    clearAuthError();

    const email = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    if (!email) {
        alert('Please enter your email!');
        return;
    }

    if (!password) {
        alert('Please enter your password!');
        return;
    }

    if (isLoginMode) {
        loginUser(email, password);
    } else {
        createUser(email, password);
    }
}

async function createUser(email, password) {
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.isValid) {
        alert(passwordValidation.message);
        return;
    }

    try {
        const userCredential = await firebase.createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        await firebase.updateProfile(user, {
            displayName: email.split('@')[0]
        });

        addSystemMessage(`Welcome, ${email.split('@')[0]}! You have been successfully connected.`);

    } catch (error) {
        console.error('Error creating user:', error);
        if (error.code === 'auth/email-already-in-use') {
            alert('This email is already in use!');
        } else if (error.code === 'auth/weak-password') {
            alert('Password is too weak!');
        } else {
            alert('Error creating account: ' + error.message);
        }
    }
}

function validatePassword(password) {
    if (password.length < 5) {
        return {
            isValid: false,
            message: 'Password must have at least 5 characters!'
        };
    }

    if (!/[a-z]/.test(password)) {
        return {
            isValid: false,
            message: 'Password must contain at least one lowercase letter!'
        };
    }

    if (!/[A-Z]/.test(password)) {
        return {
            isValid: false,
            message: 'Password must contain at least one uppercase letter!'
        };
    }

    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
        return {
            isValid: false,
            message: 'Password must contain at least one special character (!@#$%^&*()_+-=[]{}|;:,.<>?)!'
        };
    }

    return {
        isValid: true,
        message: 'Password is valid!'
    };
}

async function loginUser(email, password) {
    try {
        const userCredential = await firebase.signInWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        clearAuthError();

        addSystemMessage(`Welcome back, ${user.displayName || email.split('@')[0]}!`);

    } catch (error) {
        console.error('Error signing in:', error);
        if (
            error.code === 'auth/user-not-found' ||
            error.code === 'auth/wrong-password' ||
            error.code === 'auth/invalid-credential' ||
            error.code === 'auth/invalid-login-credentials'
        ) {
            setAuthError('Invalid email or password.');
        } else if (error.code === 'auth/invalid-email') {
            setAuthError('Please enter a valid email address.');
        } else {
            alert('Authentication error: ' + error.message);
        }
    }
}

function setAuthError(message) {
    const authError = document.getElementById('authError');
    if (!authError) return;
    authError.textContent = message;
    authError.style.display = 'block';
}

function clearAuthError() {
    const authError = document.getElementById('authError');
    if (!authError) return;
    authError.textContent = '';
    authError.style.display = 'none';
}

async function logout() {
    if (confirm('Are you sure you want to logout?')) {
        try {
            if (messagesUnsubscribe) {
                messagesUnsubscribe();
                messagesUnsubscribe = null;
            }

            await firebase.signOut(auth);

            document.getElementById('username').value = '';
            document.getElementById('password').value = '';
            isLoginMode = true;
            applyAuthModeUI();

        } catch (error) {
            console.error('Error signing out:', error);
            alert('Eroare la deconectare: ' + error.message);
        }
    }
}


async function sendMessage() {
    const messageInput = document.getElementById('messageInput');
    const message = messageInput.value.trim();

    if (!message) return;

    const spamCheck = antiSpamTryConsume('text');
    if (!spamCheck.allowed) {
        showSpamWarning(spamCheck.message);
        return;
    }

    try {
        const messagesRef = firebase.collection(db, 'messages');
        await firebase.addDoc(messagesRef, {
            sender: currentUser.username,
            text: message,
            timestamp: firebase.serverTimestamp(),
            type: 'text',
            colorClass: currentUser.colorClass,
            uid: currentUser.uid
        });

        messageInput.value = '';

        forceScrollToLatestMessage();

    } catch (error) {
        console.error('Error sending message:', error);
        alert('Error sending message: ' + error.message);
    }
}


function createMessageElement(messageObj) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${messageObj.sender === currentUser.username ? 'own' : ''}`;
    messageDiv.dataset.messageId = messageObj.id;

    const time = new Date(messageObj.timestamp).toLocaleTimeString('ro-RO', {
        hour: '2-digit',
        minute: '2-digit'
    });

    const safeSender = escapeHtml(messageObj.sender);
    const safeText = escapeHtml(messageObj.text);
    if (messageObj.type === 'system') {
        messageDiv.innerHTML = `
        <div class="message-avatar system-message">S</div>
        <div class="message-content system-message">
            <div class="message-header">
                <span class="message-sender">System</span>
                <span class="message-time">${time}</span>
            </div>
            <div class="message-text">${safeText}</div>
        </div>`;
        return messageDiv;
    }

    const senderColorClass = getUserDailyColor(messageObj.sender);

    let mediaContent = '';
    if (messageObj.type === 'image' && messageObj.mediaUrl) {
        mediaContent = `<div class="message-media"><img src="${messageObj.mediaUrl}" alt="Image"></div>`;
    } else if (messageObj.type === 'video' && messageObj.mediaUrl) {
        mediaContent = `<div class="message-media"><video controls><source src="${messageObj.mediaUrl}" type="video/mp4"></video></div>`;
    } else if (messageObj.type === 'gif' && messageObj.mediaUrl) {
        mediaContent = `<div class="message-media"><img src="${messageObj.mediaUrl}" alt="GIF"></div>`;
    } else if (messageObj.type === 'sticker' && messageObj.mediaUrl) {
        mediaContent = `<div class="message-media sticker"><img src="${messageObj.mediaUrl}" alt="Sticker"></div>`;
    } else if (messageObj.type === 'voice' && messageObj.mediaUrl) {
        const duration = messageObj.duration || 0;
        mediaContent = `
            <div class="message-media">
                <div class="voice-message">
                    <button class="play-button" onclick="playVoiceMessage('${messageObj.mediaUrl}')">
                        <i class="fas fa-play"></i>
                    </button>
                    <audio id="voice-${messageObj.id}" src="${messageObj.mediaUrl}" preload="none"></audio>
                    <span class="duration">${duration}s</span>
                    <div class="volume-control">
                        <i class="fas fa-volume-down volume-icon" onclick="toggleMute('${messageObj.mediaUrl}')"></i>
                        <input type="range" class="volume-slider" min="0" max="100" value="70" 
                               oninput="setVolume('${messageObj.mediaUrl}', this.value)" 
                               onchange="setVolume('${messageObj.mediaUrl}', this.value)">
                    </div>
                </div>
            </div>
        `;
    }

    let reactionsHtml = '';
    const reactionsByUid = (messageObj.reactionsByUid && typeof messageObj.reactionsByUid === 'object')
        ? messageObj.reactionsByUid
        : null;
    if (reactionsByUid) {
        const counts = {};
        const ownEmoji = getOwnReactionEmojiFromMap(reactionsByUid);
        Object.values(reactionsByUid).forEach((emoji) => {
            const key = String(emoji || '').trim();
            if (!key) return;
            counts[key] = (counts[key] || 0) + 1;
        });
        const entries = Object.entries(counts);
        const namesByUid = (messageObj.reactionNamesByUid && typeof messageObj.reactionNamesByUid === 'object')
            ? messageObj.reactionNamesByUid
            : null;
        if (entries.length > 0) {
            reactionsHtml = '<div class="message-reactions">';
            entries.forEach(([emoji, count]) => {
                const safeEmoji = escapeHtml(emoji);
                const safeMessageId = escapeHtml(messageObj.id);
                const hasReacted = ownEmoji === emoji;
                const reactorsForEmoji = Object.entries(reactionsByUid).filter(
                    ([, v]) => String(v ?? '').trim() === emoji
                );
                reactorsForEmoji.sort(([ka], [kb]) =>
                    displayNameForReactionUser(ka, namesByUid).localeCompare(
                        displayNameForReactionUser(kb, namesByUid),
                        undefined,
                        { sensitivity: 'base' }
                    )
                );
                const tooltipInner = reactorsForEmoji
                    .map(([uidKey]) => {
                        const name = displayNameForReactionUser(uidKey, namesByUid);
                        const line = `${name} — ${emoji}`;
                        return `<span class="reaction-tooltip-line">${escapeHtml(line)}</span>`;
                    })
                    .join('');
                reactionsHtml += `
                    <button type="button" class="reaction ${hasReacted ? 'reacted' : ''}" data-emoji="${safeEmoji}" data-message-id="${safeMessageId}" aria-label="Reacted with ${safeEmoji}, ${count} ${count === 1 ? 'person' : 'people'}">
                        <span class="reaction-tooltip" role="tooltip">${tooltipInner}</span>
                        ${safeEmoji} <span class="reaction-count">${count}</span>
                    </button>
                `;
            });
            reactionsHtml += '</div>';
        }
    } else if (messageObj.reactions && Object.keys(messageObj.reactions).length > 0) {
        reactionsHtml = '<div class="message-reactions">';
        let currentUserReactionAlreadyAssigned = false;
        for (const [emoji, users] of Object.entries(messageObj.reactions)) {
            const normalizedUsers = Array.isArray(users) ? Array.from(new Set(users.map((u) => String(u)))) : [];
            const containsCurrentUser = normalizedUsers.some((u) => isCurrentUserIdentity(u));
            let displayUsers = normalizedUsers;
            let hasReacted = false;
            if (containsCurrentUser) {
                if (!currentUserReactionAlreadyAssigned) {
                    const withoutCurrentUser = normalizedUsers.filter((u) => !isCurrentUserIdentity(u));
                    displayUsers = [...withoutCurrentUser, currentUser.uid];
                    hasReacted = true;
                    currentUserReactionAlreadyAssigned = true;
                } else {
                    displayUsers = normalizedUsers.filter((u) => !isCurrentUserIdentity(u));
                    hasReacted = false;
                }
            }
            const count = displayUsers.length;
            if (count === 0) continue;
            const safeEmoji = escapeHtml(emoji);
            const safeMessageId = escapeHtml(messageObj.id);
            const legacyNames = (messageObj.reactionNamesByUid && typeof messageObj.reactionNamesByUid === 'object')
                ? messageObj.reactionNamesByUid
                : null;
            const sortedLegacy = [...displayUsers].sort((a, b) =>
                displayNameForReactionUser(a, legacyNames).localeCompare(
                    displayNameForReactionUser(b, legacyNames),
                    undefined,
                    { sensitivity: 'base' }
                )
            );
            const tooltipInner = sortedLegacy
                .map((u) => {
                    const name = displayNameForReactionUser(u, legacyNames);
                    const line = `${name} — ${emoji}`;
                    return `<span class="reaction-tooltip-line">${escapeHtml(line)}</span>`;
                })
                .join('');
            reactionsHtml += `
                <button type="button" class="reaction ${hasReacted ? 'reacted' : ''}" data-emoji="${safeEmoji}" data-message-id="${safeMessageId}" aria-label="Reacted with ${safeEmoji}, ${count} ${count === 1 ? 'person' : 'people'}">
                    <span class="reaction-tooltip" role="tooltip">${tooltipInner}</span>
                    ${safeEmoji} <span class="reaction-count">${count}</span>
                </button>
            `;
        }
        reactionsHtml += '</div>';
    }

    messageDiv.innerHTML = `
        <div class="message-avatar ${senderColorClass}">${messageObj.sender.charAt(0).toUpperCase()}</div>
        <div class="message-content ${senderColorClass}">
            <div class="message-header">
                <span class="message-sender">${safeSender}</span>
                <span class="message-time">${time}</span>
                <button class="add-reaction-btn" title="Add reaction" data-message-id="${messageObj.id}">
                    <i class="fas fa-smile"></i>
                </button>
            </div>
            <div class="message-text">${safeText}</div>
            ${mediaContent}
            ${reactionsHtml}
        </div>
    `;

    const imgs = messageDiv.querySelectorAll('img');
    imgs.forEach((img) => {
        if (img.complete) return;
        img.addEventListener('load', forceScrollToLatestMessage, { once: true });
        img.addEventListener('error', forceScrollToLatestMessage, { once: true });
    });
    const videos = messageDiv.querySelectorAll('video');
    videos.forEach((video) => {
        video.addEventListener('loadedmetadata', forceScrollToLatestMessage, { once: true });
        video.addEventListener('canplay', forceScrollToLatestMessage, { once: true });
    });

    messageDiv.querySelectorAll('.reaction').forEach(btn => {
        btn.addEventListener('click', handleReaction);
    });
    const addBtn = messageDiv.querySelector('.add-reaction-btn');
    if (addBtn) {
        addBtn.addEventListener('click', (ev) => openReactionPicker(messageObj.id, ev.currentTarget));
    }

    return messageDiv;
}

async function handleReaction(e) {
    const btn = e.target.closest('.reaction');
    if (!btn) return;
    const clickedEmoji = String(btn.dataset.emoji || '').trim();
    const messageId = btn.dataset.messageId;
    if (!currentUser?.uid || !clickedEmoji || !messageId) return;

    const messagesRef = firebase.collection(db, 'messages');
    const targetRef = firebase.doc(messagesRef, messageId);
    const reactorId = currentUser.uid;

    try {
        const preSnap = await firebase.getDoc(targetRef);
        if (!preSnap.exists()) return;
        await prefetchUsernamesForReactionMaps([
            {
                reactionsByUid: preSnap.data()?.reactionsByUid,
                reactionNamesByUid: preSnap.data()?.reactionNamesByUid
            }
        ]);

        await firebase.runTransaction(db, async (transaction) => {
            const snap = await transaction.get(targetRef);
            if (!snap.exists()) return;

            const data = snap.data() || {};
            const prevByUid = (data.reactionsByUid && typeof data.reactionsByUid === 'object')
                ? { ...data.reactionsByUid }
                : {};
            const prevNamesByUid = (data.reactionNamesByUid && typeof data.reactionNamesByUid === 'object')
                ? { ...data.reactionNamesByUid }
                : {};
            const legacyReactions = (data.reactions && typeof data.reactions === 'object') ? data.reactions : {};

            const byUid = {};
            const nu = normalizeIdentityKey(reactorId);

            Object.entries(prevByUid).forEach(([k, v]) => {
                const emojiVal = String(v ?? '').trim();
                if (!emojiVal) return;
                if (normalizeIdentityKey(k) === nu || isSameUserIdentity(k, reactorId, currentUser.username)) {
                    return;
                }
                byUid[k] = emojiVal;
            });

            const hasAuthoritativeByUid = countValidReactionsByUidEntries(prevByUid) > 0;
            if (!hasAuthoritativeByUid) {
                Object.entries(legacyReactions).forEach(([emojiKey, users]) => {
                    if (!Array.isArray(users)) return;
                    const em = String(emojiKey || '').trim();
                    if (!em) return;
                    users.forEach((rawUser) => {
                        const token = String(rawUser ?? '').trim();
                        if (!token) return;
                        if (isCurrentUserIdentity(token)) return;
                        if (byUidAlreadyHasIdentity(byUid, token)) return;
                        byUid[token] = em;
                    });
                });
            }

            const effectiveMine = getOwnReactionEmojiFromMap(prevByUid);

            if (effectiveMine === clickedEmoji) {
                delete byUid[reactorId];
            } else {
                byUid[reactorId] = clickedEmoji;
            }

            const reactions = {};
            Object.entries(byUid).forEach(([uidKey, em]) => {
                const e = String(em || '').trim();
                if (!e) return;
                if (!reactions[e]) reactions[e] = [];
                reactions[e].push(uidKey);
            });

            const updates = { reactions };
            const nextKeys = new Set(Object.keys(byUid));
            const prevKeys = new Set(Object.keys(prevByUid));
            const reactorNu = normalizeIdentityKey(reactorId);
            const myDisplayName = String(currentUser.username || 'You').trim() || 'You';

            const namesByUid = {};
            nextKeys.forEach((k) => {
                if (normalizeIdentityKey(k) === reactorNu) {
                    namesByUid[k] = myDisplayName;
                } else if (prevNamesByUid[k] != null && String(prevNamesByUid[k]).trim() !== '') {
                    namesByUid[k] = String(prevNamesByUid[k]).trim();
                } else if (!looksLikeFirebaseUidKey(k)) {
                    namesByUid[k] = String(k);
                } else {
                    const c = usernameDirectoryCache[k];
                    namesByUid[k] = (c && String(c).trim()) || fallbackUidDisplayLabel(k);
                }
            });

            prevKeys.forEach((k) => {
                if (!nextKeys.has(k)) {
                    updates[`reactionsByUid.${k}`] = firebase.deleteField();
                }
            });
            nextKeys.forEach((k) => {
                updates[`reactionsByUid.${k}`] = byUid[k];
            });

            const prevNameKeys = new Set(Object.keys(prevNamesByUid));
            prevNameKeys.forEach((k) => {
                if (!nextKeys.has(k)) {
                    updates[`reactionNamesByUid.${k}`] = firebase.deleteField();
                }
            });
            nextKeys.forEach((k) => {
                updates[`reactionNamesByUid.${k}`] = namesByUid[k];
            });

            transaction.update(targetRef, updates);
        });
    } catch (error) {
        console.error('Error updating reaction:', error);
    }
}



async function addSystemMessage(text) {
    try {
        const messagesRef = firebase.collection(db, 'messages');
        await firebase.addDoc(messagesRef, {
            sender: 'System',
            text: text,
            timestamp: firebase.serverTimestamp(),
            type: 'system',
            colorClass: 'system-message'
        });
    } catch (error) {
        console.error('Error adding system message:', error);
    }
}

async function clearMessages() {
    if (confirm('Clear chat for this session only? This hides existing messages for your view until you reload.')) {
        sessionClearAfter = Date.now();
        clearMessagesListDom();
    }
}

function clearAllMessagesPermanentlyLocal() {
    if (confirm('This will erase all messages permanently. Are you sure?')) {
        permanentClearAfter = Date.now();
        persistPermanentClearState();
        clearMessagesListDom();
    }
}

function refreshAllMessagesFromDatabase() {
    const shouldRefresh = confirm('This will refresh and fetch all messages from the database.\nAre you sure?');
    if (!shouldRefresh) return;

    sessionClearAfter = null;
    permanentClearAfter = null;
    persistPermanentClearState();

    clearMessagesListDom();
    setupRealtimeMessages();
}

function clearMessagesListDom() {
    const messagesList = document.getElementById('messagesList');
    if (!messagesList) return;
    Array.from(messagesList.children).forEach((child) => {
        if (child.parentNode) child.parentNode.removeChild(child);
    });
}

function getPermanentClearStorageKey() {
    if (!currentUser?.uid) return null;
    return `chatPermanentClearAfter_${currentUser.uid}`;
}

function loadPermanentClearState() {
    const key = getPermanentClearStorageKey();
    if (!key) {
        permanentClearAfter = null;
        return;
    }
    const storedValue = localStorage.getItem(key);
    const parsed = storedValue ? Number(storedValue) : 0;
    permanentClearAfter = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function persistPermanentClearState() {
    const key = getPermanentClearStorageKey();
    if (!key) return;
    if (permanentClearAfter && Number.isFinite(permanentClearAfter)) {
        localStorage.setItem(key, String(permanentClearAfter));
    } else {
        localStorage.removeItem(key);
    }
}

function showSpamWarning(message) {
    const warningDiv = document.createElement('div');
    warningDiv.className = 'spam-warning';
    warningDiv.textContent = message;
    warningDiv.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(255, 0, 0, 0.9);
        color: white;
        padding: 15px 25px;
        border-radius: 10px;
        font-size: 14px;
        font-weight: 600;
        z-index: 10000;
        box-shadow: 0 0 20px rgba(255, 0, 0, 0.5);
        animation: spamWarningFade 3s ease-in-out forwards;
    `;

    if (!document.getElementById('spamWarningStyle')) {
        const style = document.createElement('style');
        style.id = 'spamWarningStyle';
        style.textContent = `
            @keyframes spamWarningFade {
                0% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
                20% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
                80% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
                100% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
            }
        `;
        document.head.appendChild(style);
    }

    document.body.appendChild(warningDiv);

    setTimeout(() => {
        if (warningDiv.parentNode) {
            warningDiv.parentNode.removeChild(warningDiv);
        }
    }, 3000);
}

function initializeEmojiPicker() {
    document.querySelectorAll('.emoji-category').forEach(btn => {
        btn.addEventListener('click', function () {
            document.querySelectorAll('.emoji-category').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            showEmojiCategory(this.dataset.category);
        });
    });

    showEmojiCategory('smileys');
}

function showEmojiCategory(category) {
    const emojiGrid = document.getElementById('emojiGrid');
    if (!emojiGrid) {
        console.error('Emoji grid element not found');
        return;
    }

    const emojis = emojiCategories[category];
    if (!emojis) {
        console.error('Emoji category not found:', category);
        return;
    }

    emojiGrid.innerHTML = '';
    emojis.forEach(emoji => {
        const emojiBtn = document.createElement('button');
        emojiBtn.className = 'emoji-item';
        emojiBtn.textContent = emoji;
        emojiBtn.addEventListener('click', () => insertEmoji(emoji));
        emojiGrid.appendChild(emojiBtn);
    });
}

function openReactionPicker(messageId, anchorEl) {
    const existing = document.getElementById('reactionPicker');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    const picker = document.createElement('div');
    picker.id = 'reactionPicker';
    picker.className = 'reaction-picker';
    const emojis = ['👍', '❤️', '😂', '😮', '😢', '👏', '🔥', '🎉', '😍', '😎', '🙏', '💯'];
    emojis.forEach(e => {
        const btn = document.createElement('button');
        btn.className = 'emoji-item';
        btn.textContent = e;
        btn.addEventListener('click', () => {
            handleReaction({ target: { closest: () => ({ dataset: { emoji: e, messageId } }) } });
            if (picker.parentNode) picker.parentNode.removeChild(picker);
        });
        picker.appendChild(btn);
    });
    document.body.appendChild(picker);
    const rect = anchorEl.getBoundingClientRect();
    const pr = picker.getBoundingClientRect();
    let left = rect.left + (rect.width / 2) - (pr.width / 2);
    let top = rect.top - pr.height - 8;
    const margin = 8;
    const maxLeft = window.innerWidth - pr.width - margin;
    if (left < margin) left = margin;
    if (left > maxLeft) left = maxLeft;
    if (top < margin) top = margin;
    picker.style.left = Math.round(left) + 'px';
    picker.style.top = Math.round(top) + 'px';
    picker.style.position = 'fixed';

    const closeOnClick = (e) => {
        if (!e.target.closest('#reactionPicker')) {
            if (picker.parentNode) picker.parentNode.removeChild(picker);
            document.removeEventListener('click', closeOnClick);
        }
    };
    setTimeout(() => document.addEventListener('click', closeOnClick), 0);
}
function insertEmoji(emoji) {
    const input = document.getElementById('messageInput');
    if (!input) return;
    input.focus();
    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    const value = input.value;
    input.value = value.slice(0, start) + emoji + value.slice(end);
    const newCaret = start + emoji.length;
    input.selectionStart = input.selectionEnd = newCaret;
}


function toggleEmojiPicker() {
    const picker = document.getElementById('emojiPicker');
    if (!picker) {
        console.error('Emoji picker element not found');
        return;
    }

    const isVisible = picker.style.display === 'block';

    const gifPicker = document.getElementById('gifPicker');
    if (gifPicker) {
        gifPicker.style.display = 'none';
    }

    if (isVisible) {
        picker.style.display = 'none';
    } else {
        picker.style.display = 'block';
        positionEmojiPicker();
        if (!picker.querySelector('.emoji-item')) {
            showEmojiCategory('smileys');
        }
        const input = document.getElementById('messageInput');
        if (input) {
            input.focus();
            const len = input.value.length;
            input.selectionStart = input.selectionEnd = len;
        }
    }
}

function positionEmojiPicker() {
    const picker = document.getElementById('emojiPicker');
    const btn = document.getElementById('emojiBtn');
    if (!picker || !btn) return;

    const btnRect = btn.getBoundingClientRect();
    const prevDisplay = picker.style.display;
    picker.style.display = 'block';
    picker.style.position = 'fixed';
    const pickerRect = picker.getBoundingClientRect();

    let left = btnRect.left + (btnRect.width / 2) - (pickerRect.width / 2);
    let top = btnRect.top - pickerRect.height - 10;

    const margin = 10;
    const maxLeft = window.innerWidth - pickerRect.width - margin;
    if (left < margin) left = margin;
    if (left > maxLeft) left = maxLeft;
    if (top < margin) top = margin;

    picker.style.left = Math.round(left) + 'px';
    picker.style.top = Math.round(top) + 'px';
    picker.style.right = 'auto';
    picker.style.bottom = 'auto';

    picker.style.display = prevDisplay || 'block';

}

function toggleStickerPicker() {
    const picker = document.getElementById('stickerPicker');
    if (!picker) return;
    const isVisible = picker.style.display === 'block';
    const emojiPicker = document.getElementById('emojiPicker');
    const gifPicker = document.getElementById('gifPicker');
    if (emojiPicker) emojiPicker.style.display = 'none';
    if (gifPicker) gifPicker.style.display = 'none';

    if (isVisible) {
        picker.style.display = 'none';
    } else {
        picker.style.display = 'block';
        positionStickerPicker();
        buildStickerGrid();
    }
}

function positionStickerPicker() {
    const picker = document.getElementById('stickerPicker');
    const btn = document.getElementById('stickerBtn');
    if (!picker || !btn) return;

    const btnRect = btn.getBoundingClientRect();

    const originalDisplay = picker.style.display;
    const originalVisibility = picker.style.visibility;
    const originalPosition = picker.style.position;

    picker.style.display = 'block';
    picker.style.visibility = 'hidden';
    picker.style.position = 'fixed';
    picker.style.top = '0px';
    picker.style.left = '0px';

    const pickerRect = picker.getBoundingClientRect();

    let left = btnRect.left + (btnRect.width / 2) - (pickerRect.width / 2);
    let top = btnRect.top - pickerRect.height - 10;

    const margin = 10;
    const maxLeft = window.innerWidth - pickerRect.width - margin;
    if (left < margin) left = margin;
    if (left > maxLeft) left = maxLeft;

    if (top < margin) {
        top = margin;
    }

    picker.style.left = Math.round(left) + 'px';
    picker.style.top = Math.round(top) + 'px';
    picker.style.right = 'auto';
    picker.style.bottom = 'auto';

    picker.style.display = originalDisplay || 'block';
    picker.style.visibility = 'visible';
    picker.style.position = 'fixed';
}

const PREDEFINED_STICKERS = [
    'https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExMG05Mng2ZTA2dmYxcG43ZHA3em10d2ZqdGl3dHM1dWNjZzlmOXVxaSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/OfkGZ5H2H3f8Y/giphy.gif',
    'https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExbWduMnl4dXd2MHdyam85OXFpdW4yeGlqODVwMXBvY2NwdXJtbGRzNSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/13hxeOYjoTWtK8/giphy.gif',
    'https://media2.giphy.com/media/v1.Y2lkPTc5MGI3NjExamRwZm40cnIxa2hkbmg0eGUyM3RoM2JwazlvenBqY2dldXpuNmx3dSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/WRQBXSCnEFJIuxktnw/giphy.gif',
    'https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjExNGVjenVlejQyZXJpdDEwOWhuNmI0NXA0ZWR4YmZxbnN4N2N1MGZoeSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/rqtuZqeiON1SCMyJjW/giphy.gif',
    'https://media2.giphy.com/media/v1.Y2lkPTc5MGI3NjExbHI0ODF3Z2JzdW5qMWR5bmZ4a2F1NXNnemYxb2s1dGMzZmxjaTk3dyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/7NNqJw0T3cb62PMzXR/giphy.gif',
    'https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExdnpsaWl5OHF3czc5MGs5djEwMWNvNzZ1Nmw5am5kYTh5MjduY2JlNCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/MahDrOWLffiMKpiVV0/giphy.gif',
    'https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExNXlrc211emlpejVpbTA2enE0ancwcXhrNTZoN2Z1ampkNDIzam9hbSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/7AzEXdIb1wyCTWJntb/giphy.gif',
    'https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExNXQ4azdwN2NtMGY1dGpiMWtsNHJyNWc1NnlzZXlzYzYyYnA2bXBrOSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/VJQO61aEtx5Qc4mk5i/giphy.gif',
    'https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExemw5ZzIzeXQ4bnJub3Bmajc3eGVlcDNwZ2xqbGh6MGdwamd0Z2NsaCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/12d71hRlD9T2Cc/giphy.gif',
    'https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExeXEzdzh2eDg4cmxubmt0OTZmdnp2ZHAxOHptNXF1a2xyNnFqdWltaCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/MDJ9IbxxvDUQM/giphy.gif',
    'https://media.giphy.com/media/3o7aD2saalBwwftBIY/giphy.gif',
    'https://media.giphy.com/media/l0MYC0LajbaPoEADu/giphy.gif',
    'https://media.giphy.com/media/3o7TKMt1VVNkHV2PaE/giphy.gif',
    'https://media.giphy.com/media/3o7aCUQfzhWgYvrHnG/giphy.gif',
    'https://media.giphy.com/media/3oEjI1erPMTMBFmNHi/giphy.gif',
    'https://media.giphy.com/media/3oEduSbSGpGaRX2Vri/giphy.gif',
    'https://media.giphy.com/media/xT0xeJpnrWC4XWblEk/giphy.gif',
    'https://media.giphy.com/media/3orieTfp1MeFLiBQR2/giphy.gif',
    'https://media.giphy.com/media/l4FGuhL4U2WyjdkaY/giphy.gif',
    'https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif',
    'https://media.giphy.com/media/3ohzdIuqJoo8QdKlnW/giphy.gif',
    'https://media.giphy.com/media/l3q2K5jinAlChoCLS/giphy.gif',
    'https://media.giphy.com/media/26gssIytJvy1b1THO/giphy.gif',
    'https://media.giphy.com/media/3o7abAHdYvZdBNnGZq/giphy.gif',
    'https://media.giphy.com/media/26xBI73gWquCBBCDe/giphy.gif',
    'https://media.giphy.com/media/3orieLWYouYT4W0bF6/giphy.gif',
    'https://media.giphy.com/media/3o6ozuHcxTtVWJJn32/giphy.gif',
    'https://media.giphy.com/media/3orieYvhT5EVfSFyBa/giphy.gif',
    'https://media.giphy.com/media/l0Exk8EUzSLsrErEQ/giphy.gif',
    'https://media.giphy.com/media/3ohryhNgUwwZyxgktq/giphy.gif',
    'https://media.giphy.com/media/3og0IPxMM0erATueVW/giphy.gif',
    'https://media.giphy.com/media/l0HlOvJ7yaacpuSas/giphy.gif',
    'https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif',
    'https://media.giphy.com/media/3o7TKMt1VVNkHV2PaE/giphy.gif',
    'https://media.giphy.com/media/3o7aCUQfzhWgYvrHnG/giphy.gif',
    'https://media.giphy.com/media/3oEjI1erPMTMBFmNHi/giphy.gif',
    'https://media.giphy.com/media/3oEduSbSGpGaRX2Vri/giphy.gif',
    'https://media.giphy.com/media/3o7abB06u9bNzA8lu8/giphy.gif',
    'https://media.giphy.com/media/l0MYAs5E2oIDCq9So/giphy.gif',
    'https://media.giphy.com/media/xT0xeJpnrWC4XWblEk/giphy.gif'
];

async function buildStickerGrid() {
    const grid = document.getElementById('stickerGrid');
    if (!grid) return;
    if (grid.childElementCount > 0) return;
    grid.innerHTML = '';

    PREDEFINED_STICKERS.forEach((url) => {
        const item = document.createElement('div');
        item.className = 'sticker-item';
        item.innerHTML = `<img src="${url}" alt="sticker" loading="lazy">`;
        item.addEventListener('click', () => sendSticker(url));
        grid.appendChild(item);
    });
}

async function sendSticker(url) {
    const spamCheck = antiSpamTryConsume('sticker');
    if (!spamCheck.allowed) {
        showSpamWarning(spamCheck.message);
        return;
    }
    try {
        const messagesRef = firebase.collection(db, 'messages');
        await firebase.addDoc(messagesRef, {
            sender: currentUser.username,
            text: 'Sticker',
            timestamp: firebase.serverTimestamp(),
            type: 'sticker',
            colorClass: currentUser.colorClass,
            uid: currentUser.uid,
            mediaUrl: url
        });
        forceScrollToLatestMessage();
        const picker = document.getElementById('stickerPicker');
        if (picker) picker.style.display = 'none';
    } catch (error) {
        console.error('Error sending sticker:', error);
        alert('Error sending sticker: ' + error.message);
    }
}

function toggleGifPicker() {
    const picker = document.getElementById('gifPicker');
    const isVisible = picker.style.display === 'block';

    const emojiPicker = document.getElementById('emojiPicker');
    const stickerPicker = document.getElementById('stickerPicker');
    if (emojiPicker) emojiPicker.style.display = 'none';
    if (stickerPicker) stickerPicker.style.display = 'none';

    if (isVisible) {
        picker.style.display = 'none';
    } else {
        picker.style.display = 'block';
        positionGifPicker();

        const search = document.getElementById('gifSearch');
        if (search) {
            setTimeout(() => {
                search.focus();
                search.selectionStart = search.selectionEnd = search.value.length;
            }, 100);
        }

        const gifGrid = document.getElementById('gifGrid');
        if (!gifGrid || !gifGrid.hasChildNodes()) {
            console.log('Loading trending GIFs from GIPHY...');
            loadTrendingGifs();
        }
    }
}

function positionGifPicker() {
    const picker = document.getElementById('gifPicker');
    const btn = document.getElementById('gifBtn');
    if (!picker || !btn) return;

    const margin = 10;
    const btnRect = btn.getBoundingClientRect();
    const prevDisplay = picker.style.display;
    picker.style.display = 'block';
    picker.style.position = 'fixed';
    picker.style.overflow = 'hidden';
    picker.style.maxHeight = `${Math.max(220, window.innerHeight - (margin * 2))}px`;
    const pickerRect = picker.getBoundingClientRect();

    let left = btnRect.left + (btnRect.width / 2) - (pickerRect.width / 2);
    let top = btnRect.top - pickerRect.height - 10;

    const maxLeft = window.innerWidth - pickerRect.width - margin;
    const maxTop = window.innerHeight - pickerRect.height - margin;
    if (left < margin) left = margin;
    if (left > maxLeft) left = maxLeft;
    if (top < margin) top = margin;
    if (top > maxTop) top = maxTop;

    picker.style.left = Math.round(left) + 'px';
    picker.style.top = Math.round(top) + 'px';
    picker.style.right = 'auto';
    picker.style.bottom = 'auto';
    picker.style.display = prevDisplay || 'block';
}

function nudgeGifPickerUpAfterRender() {
    const picker = document.getElementById('gifPicker');
    if (!picker) return;
    if (picker.style.display !== 'block') return;

    requestAnimationFrame(() => {
        positionGifPicker();
        setTimeout(positionGifPicker, 80);
    });
}

function reopenGifPickerAfterSearch() {
    const picker = document.getElementById('gifPicker');
    if (!picker) return;

    picker.style.display = 'none';
    requestAnimationFrame(() => {
        picker.style.display = 'block';
        positionGifPicker();
        setTimeout(positionGifPicker, 80);
    });
}

async function loadTrendingGifs() {
    const gifGrid = document.getElementById('gifGrid');
    if (!gifGrid) return;

    const apiKey = getGiphyApiKey();
    if (!apiKey) {
        gifGrid.innerHTML = `<div class="gif-error">${getGiphyApiErrorHint()}</div>`;
        return;
    }

    gifGrid.innerHTML = '<div class="gif-loading">Loading trending GIFs...</div>';

    try {
        const data = await fetchGiphyJson(
            `https://api.giphy.com/v1/gifs/trending?api_key=${encodeURIComponent(apiKey)}&limit=24&rating=g`
        );
        if (!Array.isArray(data.data) || data.data.length === 0) {
            throw new Error('No trending GIFs found');
        }
        renderGiphyResultsToGrid(gifGrid, data.data);
        nudgeGifPickerUpAfterRender();
    } catch (error) {
        console.error('Error loading trending GIFs:', error);
        gifGrid.innerHTML = `<div class="gif-error">Could not load GIFs: ${error.message}. ${getGiphyApiErrorHint()}</div>`;
    }
}

async function searchGifs() {
    const searchTerm = document.getElementById('gifSearch').value.trim();
    if (!searchTerm) {
        console.log('No search term provided');
        return;
    }

    console.log('Searching GIPHY for:', searchTerm);

    const gifGrid = document.getElementById('gifGrid');
    if (!gifGrid) {
        console.error('GIF grid element not found');
        return;
    }

    const apiKey = getGiphyApiKey();
    if (!apiKey) {
        gifGrid.innerHTML = `<div class="gif-error">${getGiphyApiErrorHint()}</div>`;
        return;
    }

    gifGrid.innerHTML = `<div class="gif-loading">Searching for "${searchTerm}"...</div>`;

    const searchBtn = document.getElementById('gifSearchBtn');
    const originalContent = searchBtn.innerHTML;
    searchBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    searchBtn.disabled = true;

    try {
        const data = await fetchGiphyJson(
            `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(searchTerm)}&limit=24&rating=g&lang=en`
        );
        if (!Array.isArray(data.data) || data.data.length === 0) {
            gifGrid.innerHTML = `<div class="gif-error">No GIFs found for "${searchTerm}". Try a different search term.</div>`;
            return;
        }
        renderGiphyResultsToGrid(gifGrid, data.data);
        nudgeGifPickerUpAfterRender();
    } catch (error) {
        console.error('Error searching GIPHY:', error);
        gifGrid.innerHTML = `<div class="gif-error">Search failed: ${error.message}. ${getGiphyApiErrorHint()}</div>`;
    } finally {
        searchBtn.innerHTML = originalContent;
        searchBtn.disabled = false;
        reopenGifPickerAfterSearch();
    }
}

async function sendGif(gifUrl) {
    const spamCheck = antiSpamTryConsume('gif');
    if (!spamCheck.allowed) {
        showSpamWarning(spamCheck.message);
        return;
    }

    try {
        const messagesRef = firebase.collection(db, 'messages');
        await firebase.addDoc(messagesRef, {
            sender: currentUser.username,
            text: 'GIF',
            timestamp: firebase.serverTimestamp(),
            type: 'gif',
            colorClass: currentUser.colorClass,
            uid: currentUser.uid,
            mediaUrl: gifUrl
        });

        forceScrollToLatestMessage();

    } catch (error) {
        console.error('Error sending GIF:', error);
        alert('Error sending GIF: ' + error.message);
    }
}

function openMediaOptions() {
    const mediaBtn = document.getElementById('mediaBtn');
    const rect = mediaBtn.getBoundingClientRect();

    const dropdown = document.createElement('div');
    dropdown.className = 'media-dropdown';
    dropdown.style.cssText = `
        position: absolute;
        top: ${rect.bottom + 5}px;
        right: ${window.innerWidth - rect.right}px;
        background: rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 10px;
        padding: 10px;
        z-index: 1000;
    `;

    dropdown.innerHTML = `
        <button onclick="document.getElementById('imageInput').click(); this.parentElement.remove();">
            <i class="fas fa-image"></i> Image
        </button>
        <button onclick="document.getElementById('videoInput').click(); this.parentElement.remove();">
            <i class="fas fa-video"></i> Video
        </button>
    `;

    document.body.appendChild(dropdown);

    setTimeout(() => {
        document.addEventListener('click', function removeDropdown() {
            dropdown.remove();
            document.removeEventListener('click', removeDropdown);
        });
    }, 100);
}

function handleImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    handleImageFile(file);
    e.target.value = '';
}

async function handleImageFile(file) {
    if (!file.type || !file.type.startsWith('image/')) {
        alert('Please select only image files.');
        return;
    }

    if (!validateFirestoreInlineMediaSize(file, MAX_IMAGE_FILE_BYTES, 'Image file')) return;

    try {
        const mediaUrl = await fileToDataUrl(file);
        const messagesRef = firebase.collection(db, 'messages');
        await firebase.addDoc(messagesRef, {
            sender: currentUser.username,
            text: 'Image',
            timestamp: firebase.serverTimestamp(),
            type: 'image',
            colorClass: currentUser.colorClass,
            uid: currentUser.uid,
            mediaUrl
        });
        forceScrollToLatestMessage();
    } catch (error) {
        console.error('Error sending image:', error);
        alert('Error sending image: ' + error.message);
    }
}

function handleVideoUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    handleVideoFile(file);
    e.target.value = '';
}

async function handleVideoFile(file) {
    if (!file.type || !file.type.startsWith('video/')) {
        alert('Please select only video files.');
        return;
    }

    if (!validateFirestoreInlineMediaSize(file, MAX_VIDEO_FILE_BYTES, 'Video file')) return;

    try {
        const mediaUrl = await fileToDataUrl(file);
        const messagesRef = firebase.collection(db, 'messages');
        await firebase.addDoc(messagesRef, {
            sender: currentUser.username,
            text: 'Video',
            timestamp: firebase.serverTimestamp(),
            type: 'video',
            colorClass: currentUser.colorClass,
            uid: currentUser.uid,
            mediaUrl
        });
        forceScrollToLatestMessage();
    } catch (error) {
        console.error('Error sending video:', error);
        alert('Error sending video: ' + error.message);
    }
}

async function pickStrictFile(options) {
    if (typeof window.showOpenFilePicker !== 'function') {
        return { file: null, shouldFallback: true };
    }

    try {
        const [fileHandle] = await window.showOpenFilePicker({
            multiple: false,
            excludeAcceptAllOption: true,
            startIn: options.startIn,
            types: [{ description: options.description, accept: options.accept }]
        });
        return { file: await fileHandle.getFile(), shouldFallback: false };
    } catch (error) {
        if (error && error.name === 'AbortError') {
            return { file: null, shouldFallback: false };
        }
        return { file: null, shouldFallback: true };
    }
}

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read selected file.'));
        reader.readAsDataURL(file);
    });
}

function generateUserId() {
    return 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString('ro-RO', {
        hour: '2-digit',
        minute: '2-digit'
    });
}

setInterval(() => {
    if (currentUser) {
        localStorage.setItem('chatUser', JSON.stringify(currentUser));
    }
}, 30000);




async function toggleVoiceRecording() {
    if (!isRecording) {
        await startVoiceRecording();
    } else {
        stopVoiceRecording();
    }
}

async function startVoiceRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
            audioChunks.push(event.data);
        };

        mediaRecorder.onstop = () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
            sendVoiceMessage(audioBlob);
            stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
        isRecording = true;
        recordingStartTime = Date.now();

        const voiceBtn = document.getElementById('voiceBtn');
        voiceBtn.classList.add('recording');
        voiceBtn.innerHTML = '<i class="fas fa-stop"></i>';
        voiceBtn.title = 'Stop recording';

    } catch (error) {
        console.error('Error accessing microphone:', error);
        alert('Cannot access microphone. Check permissions.');
    }
}

function stopVoiceRecording() {
    if (mediaRecorder && isRecording) {
        mediaRecorder.stop();
        isRecording = false;

        const voiceBtn = document.getElementById('voiceBtn');
        voiceBtn.classList.remove('recording');
        voiceBtn.innerHTML = '<i class="fas fa-microphone"></i>';
        voiceBtn.title = 'Voice message';
    }
}

async function sendVoiceMessage(audioBlob) {
    try {
        if (audioBlob.size > MAX_AUDIO_FILE_BYTES) {
            alert(`Voice message is too large. Maximum allowed is ${Math.floor(MAX_AUDIO_FILE_BYTES / 1024)}KB.`);
            return;
        }
        const estimatedDataUrlSize = estimateBase64Length(audioBlob.size) + 128;
        if (estimatedDataUrlSize > FIRESTORE_DOC_SOFT_LIMIT_BYTES) {
            alert('Voice message is too large to store inline in Firestore. Please record a shorter clip.');
            return;
        }
        const reader = new FileReader();
        reader.onload = async function () {
            const base64Audio = reader.result;
            const duration = Math.round((Date.now() - recordingStartTime) / 1000);

            const messagesRef = firebase.collection(db, 'messages');
            await firebase.addDoc(messagesRef, {
                sender: currentUser.username,
                text: `🎤 Voice message (${duration}s)`,
                timestamp: firebase.serverTimestamp(),
                type: 'voice',
                colorClass: currentUser.colorClass,
                uid: currentUser.uid,
                mediaUrl: base64Audio,
                duration: duration
            });

            forceScrollToLatestMessage();
        };
        reader.readAsDataURL(audioBlob);

    } catch (error) {
        console.error('Error sending voice message:', error);
        alert('Error sending voice message: ' + error.message);
    }
}

function playVoiceMessage(audioUrl) {
    const allAudioElements = document.querySelectorAll('audio');
    allAudioElements.forEach(audio => {
        if (!audio.paused) {
            audio.pause();
            audio.currentTime = 0;
        }
    });

    const audioElement = document.querySelector(`audio[src="${audioUrl}"]`);
    if (audioElement) {
        const playButton = audioElement.previousElementSibling;
        const playIcon = playButton.querySelector('i');

        if (audioElement.volume === 1) {
            audioElement.volume = 0.7;
        }

        playIcon.className = 'fas fa-pause';

        audioElement.play();

        audioElement.onended = () => {
            playIcon.className = 'fas fa-play';
        };

        audioElement.onpause = () => {
            playIcon.className = 'fas fa-play';
        };

        audioElement.onplay = () => {
            playIcon.className = 'fas fa-pause';
        };
    }
}

function setVolume(audioUrl, volumeValue) {
    const audioElement = document.querySelector(`audio[src="${audioUrl}"]`);
    if (audioElement) {
        const volume = volumeValue / 100;
        audioElement.volume = volume;

        const volumeIcon = audioElement.parentElement.querySelector('.volume-icon');
        if (volumeIcon) {
            if (volume === 0) {
                volumeIcon.className = 'fas fa-volume-mute volume-icon';
            } else if (volume < 0.5) {
                volumeIcon.className = 'fas fa-volume-down volume-icon';
            } else {
                volumeIcon.className = 'fas fa-volume-up volume-icon';
            }
        }
    }
}

function toggleMute(audioUrl) {
    const audioElement = document.querySelector(`audio[src="${audioUrl}"]`);
    if (audioElement) {
        const volumeSlider = audioElement.parentElement.querySelector('.volume-slider');
        const volumeIcon = audioElement.parentElement.querySelector('.volume-icon');

        if (audioElement.volume > 0) {
            audioElement.dataset.previousVolume = audioElement.volume;
            audioElement.volume = 0;
            volumeSlider.value = 0;
            volumeIcon.className = 'fas fa-volume-mute volume-icon';
        } else {
            const previousVolume = parseFloat(audioElement.dataset.previousVolume) || 0.7;
            audioElement.volume = previousVolume;
            volumeSlider.value = previousVolume * 100;

            if (previousVolume < 0.5) {
                volumeIcon.className = 'fas fa-volume-down volume-icon';
            } else {
                volumeIcon.className = 'fas fa-volume-up volume-icon';
            }
        }
    }
}
